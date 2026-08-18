import { useEffect, useId, useRef, useState } from "react";

const assistantEndpoint = "/api/assistant/stream";
const assistantModuleVersion = "1.5.0";
let ephemeralDeviceId = null;

function SendIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 3-7.5 18-3.8-7.7L2 9.5 21 3Z" /><path d="m9.7 13.3 4.6-4.6" /></svg>;
}

function CloseIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

function AssistantLogo({ className }) {
  return <span className={className}><img src="/monero-wallet-logo.svg" alt="" aria-hidden="true" /></span>;
}

function deviceId() {
  if (!ephemeralDeviceId) {
    ephemeralDeviceId = window.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return ephemeralDeviceId;
}

function parseSseBlock(block) {
  const lines = block.split("\n");
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  return { event, data: data.join("\n") };
}

export function AssistantDock({ text, language }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([{ id: "welcome", role: "assistant", text: text.assistantWelcome }]);
  const messagesRef = useRef(null);
  const panelId = useId();

  useEffect(() => {
    setMessages([{ id: "welcome", role: "assistant", text: text.assistantWelcome }]);
    setConversationId(null);
  }, [language, text.assistantWelcome]);

  useEffect(() => {
    if (open) messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  async function send(event) {
    event?.preventDefault();
    const prompt = value.trim();
    if (!prompt || sending) return;
    const userMessage = { id: `user-${Date.now()}`, role: "user", text: prompt };
    const answerId = `assistant-${Date.now()}`;
    setMessages((current) => [...current, userMessage, { id: answerId, role: "assistant", text: "" }]);
    setValue("");
    setSending(true);

    try {
      const response = await fetch(assistantEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          message: prompt,
          tenantId: "tex8",
          shopId: "monero-fast-wallet",
          appId: "xmr-website",
          anonymousDeviceId: deviceId(),
          ragMode: "auto",
        }),
      });
      if (!response.ok || !response.body) throw new Error(`assistant_http_${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      while (true) {
        const { value: chunk, done } = await reader.read();
        buffer += decoder.decode(chunk || new Uint8Array(), { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (parsed.event === "metadata") {
            try { setConversationId(JSON.parse(parsed.data).conversation_id || null); } catch { /* ignored */ }
          }
          if (parsed.event === "token") {
            answer += parsed.data;
            setMessages((current) => current.map((message) => message.id === answerId ? { ...message, text: answer } : message));
          }
          if (parsed.event === "message") {
            answer = parsed.data || answer;
            setMessages((current) => current.map((message) => message.id === answerId ? { ...message, text: answer } : message));
          }
        }
        if (done) break;
      }
      if (!answer) throw new Error("assistant_empty_response");
    } catch (error) {
      console.error("[mfw-website] assistant request failed", error);
      setMessages((current) => current.map((message) => message.id === answerId ? { ...message, text: text.assistantError } : message));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="tx8-assistant assistant-dock" data-module-version={assistantModuleVersion} data-contract-version="tex8.customer-assistant.v1">
      {open && <button className="tx8-assistant__backdrop" type="button" aria-label={text.assistantClose} onClick={() => setOpen(false)} />}
      <div className="tx8-assistant__root">
        {open && (
          <section className="tx8-assistant__panel" aria-labelledby={panelId} aria-modal="true" role="dialog">
            <header className="tx8-assistant__header">
              <div className="tx8-assistant__identity">
                <AssistantLogo className="tx8-assistant__brand-logo" />
                <span><strong id={panelId}>{text.assistantTitle}</strong><small>● {text.assistantStatus}</small></span>
              </div>
              <button className="tx8-assistant__close" type="button" aria-label={text.assistantClose} onClick={() => setOpen(false)}><CloseIcon /></button>
            </header>
            <div className="tx8-assistant__messages" ref={messagesRef} aria-live="polite">
              {messages.map((message) => (
                <div className={`tx8-assistant__message is-${message.role}`} key={message.id}>
                  {message.role === "assistant" && <AssistantLogo className="tx8-assistant__message-logo" />}
                  <p>{message.text || (sending ? "…" : "")}</p>
                </div>
              ))}
            </div>
            <p className="tx8-assistant__safety">{text.assistantSafety}</p>
          </section>
        )}
        <form className="tx8-assistant__dock" onSubmit={send}>
          <button className="tx8-assistant__chip" type="button" aria-controls={panelId} aria-expanded={open} aria-label={text.assistantOpen} onClick={() => setOpen((current) => !current)}>
            <AssistantLogo className="tx8-assistant__chip-logo" /><b>AI</b>
          </button>
          <label className="tx8-assistant__input">
            <span className="visually-hidden">{text.assistantPlaceholder}</span>
            <input aria-label={text.assistantPlaceholder} value={value} onFocus={() => setOpen(true)} onChange={(event) => setValue(event.target.value)} placeholder={text.assistantPlaceholder} disabled={sending} maxLength={800} autoComplete="off" />
          </label>
          <button className="tx8-assistant__send" type="submit" disabled={!value.trim() || sending} aria-label={text.assistantSend}><SendIcon /></button>
        </form>
      </div>
    </div>
  );
}
