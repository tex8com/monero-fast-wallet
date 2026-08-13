import { useId } from "react";

// TEX8 React UI AssistantPanel contract v0.4.0. Transport and identity remain
// in the consuming product so the same presentational module can be reused.
export function AssistantPanel({ title, statusLabel, messages, value, placeholder, isSending, onValueChange, onSend, onClose, sendLabel, closeLabel, safety }) {
  const inputId = useId();
  return (
    <aside className="tx8-ui-assistant" aria-label={title} data-tex8-module="assistant-panel-v0.4">
      <header className="tx8-ui-assistant__header">
        <div><b>{title}</b><span>● {statusLabel}</span></div>
        <button type="button" className="tx8-ui-icon-button" onClick={onClose} aria-label={closeLabel}>×</button>
      </header>
      <div className="tx8-ui-assistant__messages" aria-live="polite">
        {messages.map((message) => <p className={message.role === "user" ? "is-user" : ""} key={message.id}>{message.text || (isSending ? "…" : "")}</p>)}
      </div>
      <p className="tx8-ui-assistant__safety">{safety}</p>
      <form className="tx8-ui-assistant__form" onSubmit={onSend}>
        <label className="visually-hidden" htmlFor={inputId}>{placeholder}</label>
        <input id={inputId} value={value} onChange={(event) => onValueChange(event.target.value)} disabled={isSending} maxLength={800} autoComplete="off" placeholder={placeholder} />
        <button type="submit" disabled={isSending || !value.trim()} aria-label={sendLabel}>↑</button>
      </form>
    </aside>
  );
}
