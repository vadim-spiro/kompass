// Opens the assistant from anywhere with a prepared question.
export const ASK_EVENT = "kompass:ask";
export const askKompass = (text: string) => window.dispatchEvent(new CustomEvent<string>(ASK_EVENT, { detail: text }));
