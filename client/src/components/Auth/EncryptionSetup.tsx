import { useState } from 'react';
import { useLocalize } from '~/hooks';
import { deriveSessionSecret, validatePassphraseLength } from '~/utils/encryption';
import { useSetupEncryptionMutation, useUnlockEncryptionMutation } from '~/data-provider';

interface EncryptionSetupProps {
  onSuccess: () => void;
}

/**
 * Dialog shown on first login after ENCRYPT_USER_DATA is enabled.
 * Guides the user through creating an encryption passphrase.
 *
 * Flow:
 * 1. POST /api/auth/setup-encryption  → receives passphraseSalt
 * 2. Client derives sessionSecret = PBKDF2(passphrase, salt, 600000, SHA-256)
 * 3. POST /api/auth/unlock-encryption { sessionSecret } → UEK generated and cached
 */
export default function EncryptionSetup({ onSuccess }: EncryptionSetupProps) {
  const localize = useLocalize();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [error, setError] = useState('');

  const setupMutation = useSetupEncryptionMutation();
  const unlockMutation = useUnlockEncryptionMutation();

  const isLoading = setupMutation.isLoading || unlockMutation.isLoading;
  const validation = validatePassphraseLength(passphrase);
  const canSubmit = validation.valid && passphrase === confirm && !isLoading;

  /** Length at which the passphrase strength bar is considered "strong" (turns green). */
  const STRONG_PASSPHRASE_LENGTH = 20;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!validation.valid) {
      setError(
        validation.error === 'too_short'
          ? localize('com_ui_encryption_passphrase_too_short')
          : localize('com_ui_encryption_passphrase_too_long'),
      );
      return;
    }
    if (passphrase !== confirm) {
      setError(localize('com_ui_encryption_passphrase_mismatch'));
      return;
    }

    try {
      const { passphraseSalt } = await setupMutation.mutateAsync(undefined);
      const sessionSecret = await deriveSessionSecret(passphrase, passphraseSalt);
      await unlockMutation.mutateAsync({ sessionSecret });
      onSuccess();
    } catch {
      setError(localize('com_ui_encryption_setup_error'));
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="encryption-setup-title"
      className="flex flex-col gap-4 p-6"
    >
      <h2
        id="encryption-setup-title"
        className="text-lg font-semibold text-token-text-primary"
      >
        {localize('com_ui_encryption_setup_title')}
      </h2>
      <p className="text-sm text-token-text-secondary">
        {localize('com_ui_encryption_setup_description')}
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="relative">
          <label htmlFor="encryption-passphrase" className="mb-1 block text-sm font-medium">
            {localize('com_ui_encryption_passphrase_label')}
          </label>
          <input
            id="encryption-passphrase"
            type={showPassphrase ? 'text' : 'password'}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-describedby={error ? 'encryption-error' : undefined}
            minLength={12}
            maxLength={128}
            required
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

        <div>
          <label htmlFor="encryption-confirm" className="mb-1 block text-sm font-medium">
            {localize('com_ui_encryption_confirm_label')}
          </label>
          <input
            id="encryption-confirm"
            type={showPassphrase ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            maxLength={128}
            required
            className="w-full rounded border border-token-border-medium bg-token-main-surface-primary px-3 py-2 text-sm text-token-text-primary"
          />
        </div>

        {/* Passphrase strength indicator */}
        <div className="h-1.5 w-full overflow-hidden rounded bg-token-border-medium" aria-hidden>
          <div
            className="h-full rounded transition-all"
            style={{
              width: `${Math.min((passphrase.length / STRONG_PASSPHRASE_LENGTH) * 100, 100)}%`,
              backgroundColor:
                passphrase.length < 12
                  ? '#ef4444'
                  : passphrase.length < STRONG_PASSPHRASE_LENGTH
                    ? '#f59e0b'
                    : '#22c55e',
            }}
          />
        </div>

        {error && (
          <p id="encryption-error" role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {isLoading ? localize('com_ui_loading') : localize('com_ui_encryption_setup_button')}
        </button>
      </form>
    </div>
  );
}
