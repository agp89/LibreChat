import { useState } from 'react';
import { useLocalize } from '~/hooks';
import { deriveSessionSecret } from '~/utils/encryption';
import { useGetEncryptionSaltQuery, useUnlockEncryptionMutation } from '~/data-provider';

interface EncryptionUnlockProps {
  /** Called after the user successfully enters their passphrase and encryption is unlocked. */
  onSuccess: () => void;
  /** Called when the user clicks "Forgot passphrase?" */
  onForgotPassphrase?: () => void;
  /** Optional — shown above the dialog when the UEK was evicted (session expiry). */
  sessionExpired?: boolean;
}

/**
 * Dialog shown after authentication to unlock encryption by entering the passphrase.
 *
 * Flow:
 * 1. GET /api/auth/encryption-salt → passphraseSalt
 * 2. Client derives sessionSecret = PBKDF2(passphrase, salt, 600000, SHA-256)
 * 3. POST /api/auth/unlock-encryption { sessionSecret }
 */
export default function EncryptionUnlock({
  onSuccess,
  onForgotPassphrase,
  sessionExpired = false,
}: EncryptionUnlockProps) {
  const localize = useLocalize();
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [error, setError] = useState('');

  const { data: saltData } = useGetEncryptionSaltQuery();
  const unlockMutation = useUnlockEncryptionMutation();

  const isLoading = unlockMutation.isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!saltData?.passphraseSalt) {
      setError(localize('com_ui_encryption_setup_error'));
      return;
    }

    try {
      const sessionSecret = await deriveSessionSecret(passphrase, saltData.passphraseSalt);
      await unlockMutation.mutateAsync({ sessionSecret });
      onSuccess();
    } catch (err: unknown) {
      const apiErr = err as { response?: { data?: { error?: string; retryAfter?: number } } };
      const code = apiErr?.response?.data?.error;
      const retryAfter = apiErr?.response?.data?.retryAfter;

      if (code === 'passphrase_rate_limited') {
        setError(
          localize('com_ui_encryption_rate_limited', { retryAfter: String(retryAfter ?? '') }),
        );
      } else {
        setError(localize('com_ui_encryption_wrong_passphrase'));
      }
      setPassphrase('');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="encryption-unlock-title"
      className="flex flex-col gap-4 p-6"
    >
      {sessionExpired && (
        <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-700">
          {localize('com_ui_encryption_session_expired')}
        </p>
      )}

      <h2
        id="encryption-unlock-title"
        className="text-lg font-semibold text-token-text-primary"
      >
        {localize('com_ui_encryption_unlock_title')}
      </h2>
      <p className="text-sm text-token-text-secondary">
        {localize('com_ui_encryption_unlock_description')}
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="relative">
          <label htmlFor="encryption-passphrase-input" className="mb-1 block text-sm font-medium">
            {localize('com_ui_encryption_passphrase_label')}
          </label>
          <input
            id="encryption-passphrase-input"
            type={showPassphrase ? 'text' : 'password'}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-describedby={error ? 'encryption-unlock-error' : undefined}
            maxLength={128}
            required
            autoFocus
            className="w-full rounded border border-token-border-medium bg-token-main-surface-primary px-3 py-2 text-sm text-token-text-primary"
          />
          <button
            type="button"
            className="absolute right-2 top-8 text-xs text-token-text-secondary"
            onClick={() => setShowPassphrase((v) => !v)}
            aria-label={
              showPassphrase
                ? localize('com_ui_hide_password')
                : localize('com_ui_show_password')
            }
          >
            {showPassphrase ? localize('com_ui_hide') : localize('com_ui_show')}
          </button>
        </div>

        {error && (
          <p id="encryption-unlock-error" role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!passphrase || isLoading}
          className="mt-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {isLoading ? localize('com_ui_loading') : localize('com_ui_encryption_unlock_button')}
        </button>

        {onForgotPassphrase && (
          <button
            type="button"
            onClick={onForgotPassphrase}
            className="text-xs text-token-text-secondary underline"
          >
            {localize('com_ui_encryption_forgot_link')}
          </button>
        )}
      </form>
    </div>
  );
}
