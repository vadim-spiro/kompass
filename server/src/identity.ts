// Synthetic names, emails and addresses. The mock data is anonymised (birth year and a 3-digit
// postal prefix only), but MAINGAU's marketers asked to see who a customer is. Every value here
// is generated deterministically from the customer_id and marked synthetic in the UI.
import type { Identity } from "../../shared/types.ts";

const FIRST = [
  "Anna", "Lukas", "Mia", "Jonas", "Lea", "Felix", "Emma", "Paul", "Sophie", "Leon", "Marie", "Elias", "Laura", "Noah", "Julia",
  "Finn", "Hannah", "Ben", "Lena", "Tim", "Sarah", "Jan", "Katharina", "David", "Nina", "Simon", "Clara", "Moritz", "Johanna",
  "Tobias", "Carla", "Matthias", "Ida", "Sebastian", "Greta", "Florian", "Ella", "Stefan", "Amelie", "Thomas", "Petra", "Andreas",
  "Sabine", "Michael", "Monika", "Jürgen", "Ursula", "Klaus", "Birgit", "Ahmet", "Elif", "Mehmet", "Zeynep", "Luca", "Giulia",
];
const LAST = [
  "Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Schulz", "Hoffmann", "Koch", "Richter",
  "Klein", "Wolf", "Schröder", "Neumann", "Schwarz", "Braun", "Zimmermann", "Krüger", "Hofmann", "Hartmann", "Lange", "Werner",
  "Krause", "Lehmann", "Köhler", "Herrmann", "König", "Walter", "Mayer", "Huber", "Kaiser", "Fuchs", "Peters", "Lang", "Scholz",
  "Möller", "Weiß", "Jung", "Hahn", "Vogel", "Friedrich", "Keller", "Günther", "Frank", "Berger", "Winkler", "Roth", "Beck",
  "Yılmaz", "Kaya", "Demir", "Rossi", "Nowak",
];
const STREETS = [
  "Hauptstraße", "Bahnhofstraße", "Gartenweg", "Schillerstraße", "Goethestraße", "Lindenallee", "Mainstraße", "Waldstraße",
  "Rosenweg", "Kirchgasse", "Friedrichstraße", "Am Mühlbach", "Ringstraße", "Bergstraße", "Feldweg", "Uferstraße", "Taunusblick",
];

function hash(s: string, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

const ascii = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/ı/g, "i")
    .replace(/[^a-z]/g, "");

export function identityFor(customerId: string, city?: string | null, postalPrefix?: string | null): Identity {
  const firstName = FIRST[hash(customerId, 1) % FIRST.length];
  const lastName = LAST[hash(customerId, 2) % LAST.length];
  const street = `${STREETS[hash(customerId, 3) % STREETS.length]} ${1 + (hash(customerId, 4) % 120)}`;
  const prefix = (postalPrefix ?? String(600 + (hash(customerId, 5) % 50))).padStart(3, "0");
  const postalCode = `${prefix}${String(hash(customerId, 6) % 100).padStart(2, "0")}`;
  const domain = ["example-mail.de", "beispiel.de", "mail.example"][hash(customerId, 7) % 3];
  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    email: `${ascii(firstName)}.${ascii(lastName)}${hash(customerId, 8) % 90 + 10}@${domain}`,
    street,
    postalCode,
    city: city ?? "Rhein-Main",
    synthetic: true,
  };
}
