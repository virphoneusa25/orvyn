export interface SignupLegalDocument {
  id: string;
  title: string;
  requiredForAcceptance: boolean;
  content: string;
}
export interface SignupLegalBundle {
  version: string;
  requiredDocuments: string[];
  documents: SignupLegalDocument[];
}
export const LEGAL_LOAD_ERROR = "ORVYN's current legal documents could not be loaded. Reload them before creating an account.";

/** Fail closed when the review UI cannot show every required document. */
export function parseSignupLegalBundle(value: unknown): SignupLegalBundle {
  const bundle = value as SignupLegalBundle | null;
  if (!bundle || typeof bundle.version !== "string" || !bundle.version.trim()
    || !Array.isArray(bundle.requiredDocuments) || !bundle.requiredDocuments.length
    || !Array.isArray(bundle.documents)
    || bundle.requiredDocuments.some((id) => typeof id !== "string" || !bundle.documents.some((doc) =>
      doc?.id === id && doc.requiredForAcceptance === true && typeof doc.title === "string" && doc.title.trim()
      && typeof doc.content === "string" && doc.content.trim()))) {
    throw new Error(LEGAL_LOAD_ERROR);
  }
  return bundle;
}
export function signupLegalAcceptance(bundle: SignupLegalBundle | null, accepted: boolean) {
  if (!bundle) throw new Error(LEGAL_LOAD_ERROR);
  parseSignupLegalBundle(bundle);
  if (!accepted) throw new Error("Agree to the current ORVYN legal documents to continue.");
  return { legalAccepted: accepted, legalVersion: bundle.version };
}
