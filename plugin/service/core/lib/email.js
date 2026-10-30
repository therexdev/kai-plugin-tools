"use strict";

const fs = require("fs");
const path = require("path");

/*
 * Email (§7: clearly egress — talks to the user's mail server, so the whole
 * feature is OFF in Local-Only mode via the tool registry and the gateway
 * guard). Design decisions that keep this safe and simple:
 *
 *   - Credentials are app passwords (Gmail/Fastmail/etc. all require them
 *     for IMAP anyway — the UI walks the user there). Stored encrypted with
 *     the OS keychain (Electron safeStorage) when available; plain 0600
 *     file with a visible warning otherwise (headless/dev).
 *   - SENDING IS ALWAYS A HUMAN CLICK. The model can search, read, and
 *     draft; the send endpoint exists for the compose UI only and is not
 *     registered as an agent tool at all — not even behind a confirmation.
 *   - Connections are per-request (connect, do the thing, logout). Slower
 *     than a held session, but no idle socket to a mail server sitting in a
 *     privacy-first app.
 */

const INBOX_LIMIT = 20;
const BODY_CAP = 6000;

const PRESETS = [
  { id: "gmail", name: "Gmail", imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465, help: "Use an App Password: Google Account → Security → 2-Step Verification → App passwords." },
  { id: "outlook", name: "Outlook / Hotmail", imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp-mail.outlook.com", smtpPort: 587, help: "Create an app password at account.microsoft.com → Security → Advanced security options." },
  { id: "fastmail", name: "Fastmail", imapHost: "imap.fastmail.com", imapPort: 993, smtpHost: "smtp.fastmail.com", smtpPort: 465, help: "Settings → Privacy & Security → App Passwords (choose Mail access)." },
  { id: "icloud", name: "iCloud Mail", imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587, help: "appleid.apple.com → Sign-In and Security → App-Specific Passwords." },
  { id: "custom", name: "Other (IMAP/SMTP)", imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465, help: "Any provider that offers IMAP + SMTP with a password." },
];

class EmailService {
  constructor({ dataDir, safeStorage = null, onEvent }) {
    this.file = path.join(dataDir, "email.cfg");
    this.safeStorage = safeStorage; // Electron safeStorage when running in the app
    this.onEvent = onEvent || (() => {});
    this.clients=new Set();this.closed=false;
  }

  _encrypted() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.()) && this.safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  }

  saveConfig(cfg) {
    this._load();
    const clean = {
      email: String(cfg.email || "").trim(),
      imapHost: String(cfg.imapHost || "").trim(),
      imapPort: Number(cfg.imapPort) || 993,
      smtpHost: String(cfg.smtpHost || "").trim(),
      smtpPort: Number(cfg.smtpPort) || 465,
      pass: String(cfg.pass || ""),
    };
    if (!clean.email || !clean.imapHost || !clean.pass) throw new Error("email, server, and app password are required");
    if (!this._encrypted()) throw Error("Unlock secure OS storage before saving account credentials");
    const payload = JSON.stringify(clean);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp=this.file+"."+require("node:crypto").randomUUID()+".tmp";
    try{fs.writeFileSync(temp,Buffer.concat([Buffer.from("ENC1"),this.safeStorage.encryptString(payload)]),{flag:"wx",mode:0o600});fs.renameSync(temp,this.file);}finally{fs.rmSync(temp,{force:true});}
    return this.status();
  }

  _load() {
    let st;try{st=fs.lstatSync(this.file);}catch(error){if(error.code==="ENOENT")return null;throw error;}
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1024*1024)throw Error("Saved account storage is unsafe; existing data was preserved");
    const raw=fs.readFileSync(this.file);
    if(raw.subarray(0,4).toString()!=="ENC1")throw Error("Saved account credentials have an unsupported format; existing data was preserved");
    let value;try{value=JSON.parse(this.safeStorage.decryptString(raw.subarray(4)));}catch{throw Error("Saved account credentials cannot be decrypted; existing data was preserved");}
    if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Saved account credentials are invalid; existing data was preserved");return value;
  }

  removeConfig() {
    fs.rmSync(this.file, { force: true });
  }

  status() {
    const cfg = this._load();
    return {
      connected: Boolean(cfg),
      ...(cfg ? { email: cfg.email, imapHost: cfg.imapHost } : {}),
      credsEncrypted: this._encrypted(),
      presets: PRESETS,
    };
  }

  async _imap(fn) {
    if(this.closed)throw Error("Email service is stopped");const signal=require("../../transport").execution.getStore()?.signal;signal?.throwIfAborted();
    const cfg = this._load();
    if (!cfg) throw new Error("No email account connected — add one in Tools & Accounts");
    const { ImapFlow } = require("imapflow");
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: true,
      auth: { user: cfg.email, pass: cfg.pass },
      logger: false, connectionTimeout:15000, greetingTimeout:15000, socketTimeout:30000,
    });
    this.clients.add(client);const abort=()=>client.close();signal?.addEventListener("abort",abort,{once:true});
    try {
      signal?.throwIfAborted();await client.connect();signal?.throwIfAborted();
      const lock = await client.getMailboxLock("INBOX");
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      client.close();this.clients.delete(client);signal?.removeEventListener("abort",abort);
    }
  }

  /** Newest messages, headers only — fast enough to run per-open. */
  inbox(limit = INBOX_LIMIT) {
    return this._imap(async (client) => {
      const total = client.mailbox.exists;
      if (!total) return [];
      const from = Math.max(1, total - limit + 1);
      const out = [];
      for await (const msg of client.fetch(`${from}:*`, { uid: true, envelope: true, flags: true })) {
        out.push({
          uid: msg.uid,
          from: msg.envelope?.from?.[0]?.address || "(unknown)",
          fromName: msg.envelope?.from?.[0]?.name || "",
          subject: msg.envelope?.subject || "(no subject)",
          date: msg.envelope?.date || null,
          seen: msg.flags?.has("\\Seen") ?? false,
        });
      }
      return out.reverse();
    });
  }

  /** One message, parsed to plain text (HTML stripped by mailparser). */
  read(uid) {
    return this._imap(async (client) => {
      const dl = await client.download(String(uid), undefined, { uid: true });
      if (!dl?.content) throw new Error("message not found");
      const { simpleParser } = require("mailparser");
      const parsed = await simpleParser(dl.content);
      const text = (parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "").replace(/\s+\n/g, "\n").trim();
      return {
        uid,
        from: parsed.from?.text || "",
        to: parsed.to?.text || "",
        subject: parsed.subject || "",
        date: parsed.date || null,
        text: text.slice(0, BODY_CAP) + (text.length > BODY_CAP ? "\n[truncated]" : ""),
      };
    });
  }

  /** IMAP server-side text search, newest first. */
  search(query, limit = 10) {
    return this._imap(async (client) => {
      const uids = await client.search({ text: String(query || "") }, { uid: true });
      const pick = (uids || []).slice(-limit).reverse();
      const out = [];
      for (const uid of pick) {
        const msg = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
        if (msg) {
          out.push({
            uid,
            from: msg.envelope?.from?.[0]?.address || "",
            subject: msg.envelope?.subject || "",
            date: msg.envelope?.date || null,
          });
        }
      }
      return out;
    });
  }

  /** Send — reached ONLY from the compose UI after an explicit click. */
  async send({ to, subject, text }) {
    const cfg = this._load();
    if (!cfg) throw new Error("No email account connected");
    if (!String(to || "").includes("@")) throw new Error("recipient address required");
    const nodemailer = require("nodemailer");
    const transport = nodemailer.createTransport({
      host: cfg.smtpHost || cfg.imapHost.replace(/^imap\./, "smtp."),
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      requireTLS: cfg.smtpPort !== 465,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      auth: { user: cfg.email, pass: cfg.pass },
    });
    const info = await transport.sendMail({
      from: cfg.email,
      to: String(to),
      subject: String(subject || "").slice(0, 300),
      text: String(text || "").slice(0, 50000),
    });
    this.onEvent({ type: "email:sent", to: String(to) });
    return { messageId: info.messageId };
  }
  dispose(){this.closed=true;for(const client of this.clients)client.close();this.clients.clear();}
}

/** Agent tools: read-side only. Sending is not a tool on purpose. */
function registerEmailTools(registry, email) {
  registry.register({
    name: "email_search",
    description: "Search the user's email inbox by text. Returns sender, subject, date, and uid for matches.",
    params: { query: "text to search for" },
    egress: true,
    sensitive: true, // reading private mail — ask first until user trusts it
    handler: async ({ query }) => {
      const hits = await email.search(query, 8);
      return hits.length
        ? hits.map((h) => `uid ${h.uid} | ${h.date ? new Date(h.date).toISOString().slice(0, 10) : "?"} | ${h.from} | ${h.subject}`).join("\n")
        : "(no matching emails)";
    },
  });
  registry.register({
    name: "email_read",
    description: "Read one email by uid (from email_search or the inbox).",
    params: { uid: "the message uid" },
    egress: true,
    sensitive: true,
    handler: async ({ uid }) => {
      const m = await email.read(Number(uid));
      return `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.text}`;
    },
  });
}

module.exports = { EmailService, registerEmailTools, PRESETS };
