import bcrypt from "bcryptjs";

function uniquePasswordCandidates(password) {
  if (typeof password !== "string") return [];

  return [...new Set([
    password,
    password.normalize("NFC"),
    password.normalize("NFD"),
  ])];
}

export function normalizePasswordForStorage(password) {
  return typeof password === "string" ? password.normalize("NFC") : "";
}

export async function verifyPasswordAgainstHash(password, hash) {
  if (!hash || typeof hash !== "string") return false;

  for (const candidate of uniquePasswordCandidates(password)) {
    if (await bcrypt.compare(candidate, hash)) {
      return true;
    }
  }

  return false;
}
