export interface TEncryptionSaltResponse {
  passphraseSalt: string;
}

export interface TSetupEncryptionResponse {
  passphraseSalt: string;
}

export interface TUnlockEncryptionRequest {
  sessionSecret: string;
}

export interface TUnlockEncryptionResponse {
  status: 'encryption_active';
}

export interface TChangePassphraseRequest {
  oldSessionSecret: string;
  newSessionSecret: string;
}

export interface TChangePassphraseResponse {
  status: 'passphrase_changed';
  newPassphraseSalt: string;
}

export interface TResetEncryptionRequest {
  confirm: boolean;
}

export interface TResetEncryptionResponse {
  status: 'encryption_reset';
  deletedData: {
    messages: number;
    conversations: number;
    files: number;
    memories: number;
    toolcalls: number;
  };
}

export interface TEncryptionError {
  error:
    | 'encryption_not_configured'
    | 'encryption_not_enabled'
    | 'encryption_already_configured'
    | 'invalid_passphrase'
    | 'passphrase_rate_limited'
    | 'invalid_session_secret'
    | 'confirmation_required';
  retryAfter?: number;
}
