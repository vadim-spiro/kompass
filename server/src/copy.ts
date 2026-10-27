// Approved German offer copy (Du / Sie) used by the "Recommended offer" email block, plus
// guardrail checks for any text a marketer or the LLM writes.
// Rules from the brief: no personalised prices, no fake urgency, correct form of address,
// no sales content in service messages.
import type { GuardrailCheck, Tone } from "../../shared/types.ts";

interface Variant {
  subject: string;
  body: string;
  cta: string;
  short: string;
}
interface Copy {
  du: Variant;
  sie: Variant;
  agent: string[]; // talking points for the service agent
}

const T: Record<string, Copy> = {
  "P-EN-01": {
    sie: { subject: "Strom von MAINGAU: einfach und fair", body: "Sie vertrauen MAINGAU bereits bei {{lines}}. Mit StromAktiv bekommen Sie auch Ihren Strom aus einer Hand – mit einer Rechnung und einem Ansprechpartner.", cta: "Tarif ansehen", short: "Strom von MAINGAU: alles aus einer Hand. Jetzt StromAktiv ansehen." },
    du: { subject: "Dein Strom von MAINGAU", body: "Du bist schon bei MAINGAU für {{lines}}. Mit StromAktiv hast du auch deinen Strom aus einer Hand – eine Rechnung, ein Ansprechpartner.", cta: "Tarif ansehen", short: "Strom von MAINGAU: alles aus einer Hand. Schau dir StromAktiv an." },
    agent: ["Kunde hat noch keinen Stromvertrag bei MAINGAU.", "Vorteil: eine Rechnung, ein Ansprechpartner.", "Nur ansprechen, wenn das Anliegen gelöst ist."],
  },
  "P-EN-02": {
    sie: { subject: "Ihre Preisgarantie endet am {{guarantee_end}}", body: "Ihre Preisgarantie läuft am {{guarantee_end}} aus. Mit StromGarant sichern Sie sich für weitere 24 Monate planbare Preise. Wir zeigen Ihnen gern Ihre Möglichkeiten.", cta: "Preisgarantie verlängern", short: "Ihre Preisgarantie endet am {{guarantee_end}}. Jetzt mit StromGarant 24 Monate verlängern." },
    du: { subject: "Deine Preisgarantie endet am {{guarantee_end}}", body: "Deine Preisgarantie läuft am {{guarantee_end}} aus. Mit StromGarant hast du für weitere 24 Monate planbare Preise. Wir zeigen dir gern deine Möglichkeiten.", cta: "Preisgarantie verlängern", short: "Deine Preisgarantie endet am {{guarantee_end}}. Verlängere jetzt mit StromGarant für 24 Monate." },
    agent: ["Preisgarantie endet am {{guarantee_end}}.", "Anbieten: StromGarant mit 24 Monaten Preisgarantie.", "Keine Rabatte versprechen, die nicht im Katalog stehen."],
  },
  "P-EN-03": {
    sie: { subject: "Neue Heizung? Der passende Wärmestrom", body: "Wenn Sie jetzt mit einer Wärmepumpe heizen, lohnt sich ein eigener Wärmestromtarif. StromWärme ist genau dafür gemacht. Wir beraten Sie gern zum Wechsel.", cta: "StromWärme ansehen", short: "Neue Wärmepumpe? Mit StromWärme gibt es den passenden Tarif." },
    du: { subject: "Neue Heizung? Der passende Wärmestrom", body: "Wenn du jetzt mit einer Wärmepumpe heizt, lohnt sich ein eigener Wärmestromtarif. StromWärme ist genau dafür gemacht. Wir helfen dir gern beim Wechsel.", cta: "StromWärme ansehen", short: "Neue Wärmepumpe? Mit StromWärme gibt es den passenden Tarif." },
    agent: ["Gaszähler wurde abgemeldet bzw. Wärmepumpe erkannt.", "Fragen: Heizen Sie jetzt mit einer Wärmepumpe?", "Anbieten: StromWärme-Tarif."],
  },
  "P-EN-04": {
    sie: { subject: "Gas und Strom aus einer Hand", body: "Sie heizen mit Gas? Mit GasAktiv erhalten Sie Strom und Gas von MAINGAU – übersichtlich auf einer Rechnung.", cta: "GasAktiv ansehen", short: "Strom und Gas aus einer Hand: GasAktiv von MAINGAU." },
    du: { subject: "Gas und Strom aus einer Hand", body: "Du heizt mit Gas? Mit GasAktiv bekommst du Strom und Gas von MAINGAU – übersichtlich auf einer Rechnung.", cta: "GasAktiv ansehen", short: "Strom und Gas aus einer Hand: GasAktiv von MAINGAU." },
    agent: ["Hinweis auf Gasheizung (Thermostatkauf).", "Erst fragen, ob mit Gas geheizt wird."],
  },
  "P-EN-05": {
    sie: { subject: "Strom dann nutzen, wenn er günstig ist", body: "Mit Ihrem Smart Meter können Sie vom dynamischen Stromtarif profitieren: Ihr E-Auto oder Ihre Wärmepumpe läuft dann, wenn Strom an der Börse günstig ist.", cta: "Dynamischen Tarif ansehen", short: "Smart Meter vorhanden? Mit dem dynamischen Tarif günstige Stunden nutzen." },
    du: { subject: "Strom dann nutzen, wenn er günstig ist", body: "Mit deinem Smart Meter kannst du vom dynamischen Stromtarif profitieren: Dein E-Auto oder deine Wärmepumpe läuft dann, wenn Strom an der Börse günstig ist.", cta: "Dynamischen Tarif ansehen", short: "Smart Meter vorhanden? Mit dem dynamischen Tarif günstige Stunden nutzen." },
    agent: ["Smart Meter und flexible Verbraucher vorhanden.", "Dynamischen Tarif nur mit Erklärung des Preisrisikos anbieten."],
  },
  "P-MO-01": {
    sie: { subject: "Mobilfunk von MAINGAU", body: "Als MAINGAU-Kunde können Sie auch Ihren Mobilfunk bei uns haben – mit Tarifen von 10 bis 100 GB und ohne Überraschungen auf der Rechnung.", cta: "Tarife ansehen", short: "Mobilfunk von MAINGAU: Tarife von 10 bis 100 GB." },
    du: { subject: "Mobilfunk von MAINGAU", body: "Als MAINGAU-Kunde kannst du auch deinen Mobilfunk bei uns haben – mit Tarifen von 10 bis 100 GB und ohne Überraschungen auf der Rechnung.", cta: "Tarife ansehen", short: "Mobilfunk von MAINGAU: Tarife von 10 bis 100 GB." },
    agent: ["Kein Mobilfunkvertrag bei MAINGAU.", "Nur bei passendem Gesprächsanlass erwähnen."],
  },
  "P-MO-02": {
    sie: { subject: "Mehr Datenvolumen für Sie", body: "Ihr Datenvolumen war in letzter Zeit öfter aufgebraucht. Mit dem Upgrade auf die nächste Stufe surfen Sie entspannt bis zum Monatsende.", cta: "Upgrade ansehen", short: "Datenvolumen öfter aufgebraucht? Mit dem Upgrade entspannt bis Monatsende." },
    du: { subject: "Mehr Datenvolumen für dich", body: "Dein Datenvolumen war in letzter Zeit öfter aufgebraucht. Mit dem Upgrade auf die nächste Stufe surfst du entspannt bis zum Monatsende.", cta: "Upgrade ansehen", short: "Datenvolumen öfter leer? Mit dem Upgrade surfst du entspannt bis Monatsende." },
    agent: ["Datenlimit mehrfach erreicht.", "Anbieten: Upgrade auf die nächste Stufe."],
  },
  "P-MO-03": {
    sie: { subject: "Eine SIM für die ganze Familie", body: "Mit einer Zusatz-SIM nutzt auch Ihr Haushalt den MAINGAU-Mobilfunk – einfach zu Ihrem bestehenden Vertrag hinzugebucht.", cta: "Zusatz-SIM ansehen", short: "Zusatz-SIM für Ihren Haushalt: einfach zum Vertrag dazubuchen." },
    du: { subject: "Eine SIM für die ganze Familie", body: "Mit einer Zusatz-SIM nutzt auch dein Haushalt den MAINGAU-Mobilfunk – einfach zu deinem Vertrag dazugebucht.", cta: "Zusatz-SIM ansehen", short: "Zusatz-SIM für deinen Haushalt: einfach zum Vertrag dazubuchen." },
    agent: ["Haushalt größer als Anzahl SIM-Karten."],
  },
  "P-IN-01": {
    sie: { subject: "Internet von MAINGAU", body: "Schnelles Internet per DSL oder Glasfaser – jetzt auch von MAINGAU. Prüfen Sie die Verfügbarkeit an Ihrer Adresse.", cta: "Verfügbarkeit prüfen", short: "Internet von MAINGAU: Verfügbarkeit an Ihrer Adresse prüfen." },
    du: { subject: "Internet von MAINGAU", body: "Schnelles Internet per DSL oder Glasfaser – jetzt auch von MAINGAU. Prüf die Verfügbarkeit an deiner Adresse.", cta: "Verfügbarkeit prüfen", short: "Internet von MAINGAU: Verfügbarkeit an deiner Adresse prüfen." },
    agent: ["Noch kein Internet bei MAINGAU."],
  },
  "P-SL-01": {
    sie: { subject: "Mehr aus Ihrer PV-Anlage, Wärmepumpe oder E-Auto holen", body: "Mit dem HEMS Starter-Set sehen und steuern Sie Ihre Energie in einer App – so nutzen Sie mehr eigenen Strom.", cta: "HEMS entdecken", short: "Energie clever steuern: das HEMS Starter-Set." },
    du: { subject: "Hol mehr aus deiner PV-Anlage, Wärmepumpe oder deinem E-Auto", body: "Mit dem HEMS Starter-Set siehst und steuerst du deine Energie in einer App – so nutzt du mehr eigenen Strom.", cta: "HEMS entdecken", short: "Energie clever steuern: das HEMS Starter-Set." },
    agent: ["PV, Wärmepumpe oder E-Auto ohne HEMS."],
  },
  "P-SL-02": {
    sie: { subject: "Ihr Speicher kann mehr", body: "Mit der Speicher-Optimierung lädt Ihr Heimspeicher dann, wenn es sich am meisten lohnt.", cta: "Add-on ansehen", short: "Heimspeicher optimieren: das HEMS Add-on." },
    du: { subject: "Dein Speicher kann mehr", body: "Mit der Speicher-Optimierung lädt dein Heimspeicher dann, wenn es sich am meisten lohnt.", cta: "Add-on ansehen", short: "Heimspeicher optimieren: das HEMS Add-on." },
    agent: ["HEMS mit Heimspeicher vorhanden."],
  },
  "P-SL-03": {
    sie: { subject: "Ihr E-Auto mit eigenem Sonnenstrom laden", body: "Mit der Wallbox-Integration steuert Ihr HEMS das Laden – zum Beispiel mit Überschuss aus Ihrer PV-Anlage.", cta: "Integration ansehen", short: "E-Auto smart laden: Wallbox-Integration im HEMS." },
    du: { subject: "Dein E-Auto mit eigenem Sonnenstrom laden", body: "Mit der Wallbox-Integration steuert dein HEMS das Laden – zum Beispiel mit Überschuss aus deiner PV-Anlage.", cta: "Integration ansehen", short: "E-Auto smart laden: Wallbox-Integration im HEMS." },
    agent: ["HEMS plus E-Auto oder Wallbox."],
  },
  "P-SH-01": {
    sie: { subject: "Sonnenstrom vom Balkon", body: "Mit dem Balkonkraftwerk 800 W erzeugen Sie Ihren eigenen Strom – einfach einstecken und loslegen.", cta: "Im Shop ansehen", short: "Eigener Sonnenstrom: das Balkonkraftwerk 800 W im Shop." },
    du: { subject: "Sonnenstrom vom Balkon", body: "Mit dem Balkonkraftwerk 800 W erzeugst du deinen eigenen Strom – einfach einstecken und loslegen.", cta: "Im Shop ansehen", short: "Eigener Sonnenstrom: das Balkonkraftwerk 800 W im Shop." },
    agent: ["Kein PV vorhanden, Interesse an Solar."],
  },
  "P-SH-02": {
    sie: { subject: "Zu Hause laden mit der Wallbox", body: "Laden Sie Ihr E-Auto bequem zu Hause mit der Wallbox 11 kW aus dem MAINGAU-Shop.", cta: "Im Shop ansehen", short: "Bequem zu Hause laden: Wallbox 11 kW im Shop." },
    du: { subject: "Zu Hause laden mit der Wallbox", body: "Lade dein E-Auto bequem zu Hause mit der Wallbox 11 kW aus dem MAINGAU-Shop.", cta: "Im Shop ansehen", short: "Bequem zu Hause laden: Wallbox 11 kW im Shop." },
    agent: ["E-Auto-Fahrer ohne Wallbox."],
  },
  "P-SH-03": {
    sie: { subject: "Heizkosten senken mit smarten Thermostaten", body: "Smarte Thermostate heizen nur dann, wenn Sie es brauchen – einfach selbst montiert.", cta: "Im Shop ansehen", short: "Smarte Thermostate: heizen, wenn Sie es brauchen." },
    du: { subject: "Heizkosten senken mit smarten Thermostaten", body: "Smarte Thermostate heizen nur dann, wenn du es brauchst – einfach selbst montiert.", cta: "Im Shop ansehen", short: "Smarte Thermostate: heizen, wenn du es brauchst." },
    agent: ["Gaskunde ohne smarte Thermostate."],
  },
  "P-SH-04": {
    sie: { subject: "Stromfresser finden mit Smart Plugs", body: "Mit dem Smart Plug 4er-Set sehen Sie, welches Gerät wie viel Strom verbraucht.", cta: "Im Shop ansehen", short: "Stromfresser finden: Smart Plug 4er-Set im Shop." },
    du: { subject: "Stromfresser finden mit Smart Plugs", body: "Mit dem Smart Plug 4er-Set siehst du, welches Gerät wie viel Strom verbraucht.", cta: "Im Shop ansehen", short: "Stromfresser finden: Smart Plug 4er-Set im Shop." },
    agent: ["Digital aktiver Kunde."],
  },
  "P-AS-01": {
    sie: { subject: "Unterwegs laden mit MAINGAU Autostrom", body: "Mit der Autostrom-Ladekarte und App laden Sie an öffentlichen Ladepunkten in ganz Europa – zu transparenten Preisen.", cta: "Autostrom ansehen", short: "Unterwegs laden: MAINGAU Autostrom-Karte und App." },
    du: { subject: "Unterwegs laden mit MAINGAU Autostrom", body: "Mit der Autostrom-Ladekarte und App lädst du an öffentlichen Ladepunkten in ganz Europa – zu transparenten Preisen.", cta: "Autostrom ansehen", short: "Unterwegs laden: MAINGAU Autostrom-Karte und App." },
    agent: ["Wallbox vorhanden, aber kein Autostrom."],
  },
  "P-SV-01": {
    sie: { subject: "Wir kümmern uns um Ihr Anliegen", body: "Uns ist aufgefallen, dass bei Ihnen gerade etwas nicht rund läuft. Wir melden uns, um das schnell für Sie zu lösen.", cta: "Rückruf vereinbaren", short: "Wir kümmern uns um Ihr Anliegen und melden uns." },
    du: { subject: "Wir kümmern uns um dein Anliegen", body: "Uns ist aufgefallen, dass bei dir gerade etwas nicht rund läuft. Wir melden uns, um das schnell für dich zu lösen.", cta: "Rückruf vereinbaren", short: "Wir kümmern uns um dein Anliegen und melden uns." },
    agent: ["Zuerst das Problem lösen: {{service_issue}}.", "Kein Verkaufsangebot in diesem Gespräch.", "Kulanz nur nach Regel für diesen Falltyp, nicht verhandeln."],
  },
};

export function offerCopy(offerId: string, tone: Tone) {
  const c = T[offerId];
  return c ? { ...c[tone], agent: c.agent } : null;
}

export interface CopyVars {
  guarantee_end?: string;
  lines?: string;
  service_issue?: string;
}

export const fillCopy = (s: string, v: CopyVars) =>
  s.replace(/\{\{(\w+)\}\}/g, (_, k: keyof CopyVars) => v[k] ?? (k === "guarantee_end" ? "bald" : k === "lines" ? "andere Produkte" : "das offene Anliegen"));

// ---------- Guardrails ----------

const URGENCY = /\b(nur heute|nur noch|letzte chance|sofort zugreifen|jetzt oder nie|begrenzt|limitiert|solange der vorrat|countdown|läuft heute ab|schnell sein)\b/i;
export const PRICE = /(\d+[.,]?\d*\s?(€|eur\b|euro|cent|%))|(€\s?\d)/i;
// Du imperatives carry no pronoun ("Antworte einfach"), so the common ones are listed too;
// after "ich" the same form is first person ("Ich prüfe das gern mit Ihnen") and fine.
const DU_WORDS = /\b(du|dir|dich|dein\w*)\b|(?<!\bich\s+)\b(antworte|schreib|ruf|melde|entdecke|sichere|wechsle|prüfe|nutze|schau)\b/i;
const SIE_WORDS = /\b(Sie|Ihnen|Ihr\w*)\b/;
export const SALES = /\b(angebot|tarif|rabatt|upgrade|shop|kaufen|bestellen|wechsel)\w*/i;

/** Checks one piece of free text (written by a marketer or the LLM). */
export function checkFreeText(text: string, tone: Tone, opts: { serviceOnly?: boolean; avoidWords?: string[]; allowNumbers?: boolean } = {}): GuardrailCheck[] {
  const checks: GuardrailCheck[] = [];
  const price = opts.allowNumbers ? undefined : text.match(PRICE)?.[0];
  checks.push({ check: "No prices or discounts in free text", passed: !price, detail: price ? `found "${price}"` : undefined });
  const urg = text.match(URGENCY)?.[0];
  checks.push({ check: "No artificial urgency", passed: !urg, detail: urg ? `found "${urg}"` : undefined });
  const wrong = tone === "sie" ? text.match(DU_WORDS)?.[0] : text.match(SIE_WORDS)?.[0];
  checks.push({ check: `Consistent ${tone === "du" ? "Du" : "Sie"} form`, passed: !wrong, detail: wrong ? `found "${wrong}"` : undefined });
  if (opts.serviceOnly) {
    const s = text.match(SALES)?.[0];
    checks.push({ check: "No sales wording in a service message", passed: !s, detail: s ? `found "${s}"` : undefined });
  }
  const avoid = (opts.avoidWords ?? []).find((w) => w && text.toLowerCase().includes(w.toLowerCase()));
  checks.push({ check: "Brand voice: no words on the avoid list", passed: !avoid, detail: avoid ? `found "${avoid}"` : undefined });
  return checks;
}
