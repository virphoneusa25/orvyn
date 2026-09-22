// What gets written to orvyn-connection.json.
// Account session tokens are ciphertext only. A missing OS keychain must
// drop the token rather than leave orvsess_ in the file.

export interface StoredConnection {
  backendUrl: string;
  apiKey?: string;
  sessionTokenEnc?: string;
}

export function connectionFileRecord(
  config: { backendUrl: string; apiKey: string },
  encryptSession: (token: string) => string | null
): StoredConnection {
  const record: StoredConnection = { backendUrl: config.backendUrl };
  if (config.apiKey.startsWith("orvsess_")) {
    const enc = encryptSession(config.apiKey);
    if (enc) record.sessionTokenEnc = enc;
    return record;
  }
  if (config.apiKey) record.apiKey = config.apiKey;
  return record;
}
