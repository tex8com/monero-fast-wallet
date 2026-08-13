import { useEffect, useRef, useState } from "react";
import { assistantKnowledge } from "./content";
import { AssistantPanel } from "./tex8/AssistantPanel";

const assistantEndpoint = "/api/assistant/stream";

function deviceId() {
  const key = "mfw.website.assistant.device.v1";
  const saved = window.localStorage.getItem(key);
  if (saved) return saved;
  const value = window.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(key, value);
  return value;
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

  useEffect(() => {
    setMessages([{ id: "welcome", role: "assistant", text: text.assistantWelcome }]);
    setConversationId(null);
  }, [language, text.assistantWelcome]);

  useEffect(() => {
    if (open) messagesRef.current?.scrollIntoView({ block: "end" });
  }, [messages, open]);

  async function send(event) {
    event.preventDefault();
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
          system_instructions: assistantKnowledge,
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
    <div className={`assistant-dock ${open ? "is-open" : ""}`}>
      {open && <div ref={messagesRef}><AssistantPanel title={text.assistantTitle} statusLabel={text.assistantStatus} messages={messages} value={value} placeholder={text.assistantPlaceholder} isSending={sending} onValueChange={setValue} onSend={send} onClose={() => setOpen(false)} sendLabel={text.assistantSend} closeLabel={text.assistantClose} safety={text.assistantSafety} /></div>}
      {!open && <button className="assistant-trigger" type="button" onClick={() => setOpen(true)} aria-label={text.assistantOpen}><span aria-hidden="true">✦</span><b>{text.assistantTitle}</b></button>}
    </div>
  );
}
