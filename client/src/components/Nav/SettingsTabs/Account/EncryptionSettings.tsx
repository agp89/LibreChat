import React, { useState } from 'react';
import {
  OGDialogTemplate,
  Label,
  Button,
  OGDialog,
  OGDialogTrigger,
  Spinner,
} from '@librechat/client';
import { dataService } from 'librechat-data-provider';
import {
  useChangeEncryptionPassphraseMutation,
  useResetEncryptionMutation,
  useGetStartupConfig,
} from '~/data-provider';
import { deriveSessionSecret, validatePassphraseLength } from '~/utils/encryption';
import { useLocalize } from '~/hooks';

export default function EncryptionSettings() {
  const localize = useLocalize();
  const { data: config } = useGetStartupConfig();
  const changeMutation = useChangeEncryptionPassphraseMutation();
  const resetMutation = useResetEncryptionMutation();

  const [changeOpen, setChangeOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [changeError, setChangeError] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);

  if (!config?.encryptionEnabled) {
    return null;
  }

  const handleChangePassphrase = async () => {
    setChangeError('');
    if (!currentPass || !newPass || !newPassConfirm) {
      return;
    }
    const newValidation = validatePassphraseLength(newPass);
    if (!newValidation.valid) {
      setChangeError(
        newValidation.error === 'too_short'
          ? localize('com_ui_encryption_passphrase_too_short')
          : localize('com_ui_encryption_passphrase_too_long'),
      );
      return;
    }
    if (newPass !== newPassConfirm) {
      setChangeError(localize('com_ui_encryption_passphrase_mismatch'));
      return;
    }

    try {
      const { passphraseSalt } = await dataService.getEncryptionSalt();
      const oldSessionSecret = await deriveSessionSecret(currentPass, passphraseSalt);
      const newSessionSecret = await deriveSessionSecret(newPass, passphraseSalt);
      await changeMutation.mutateAsync({ oldSessionSecret, newSessionSecret });
      setChangeOpen(false);
      setCurrentPass('');
      setNewPass('');
      setNewPassConfirm('');
    } catch (err: unknown) {
      const apiErr = err as { response?: { data?: { error?: string } } };
      if (apiErr?.response?.data?.error === 'invalid_passphrase') {
        setChangeError(localize('com_ui_encryption_wrong_passphrase'));
      } else {
        setChangeError(localize('com_ui_encryption_setup_error'));
      }
    }
  };

  const handleResetEncryption = () => {
    if (!resetConfirm) {
      return;
    }
    resetMutation.mutate(
      { confirm: true },
      {
        onSuccess: () => {
          setResetOpen(false);
          setResetConfirm(false);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label>{localize('com_ui_encryption_change_title')}</Label>
        <OGDialog open={changeOpen} onOpenChange={setChangeOpen}>
          <OGDialogTrigger asChild>
            <Button variant="outline" onClick={() => setChangeOpen(true)}>
              {localize('com_ui_encryption_change_button')}
            </Button>
          </OGDialogTrigger>
          <OGDialogTemplate
            showCloseButton={false}
            title={localize('com_ui_encryption_change_title')}
            className="max-w-[450px]"
            main={
              <div className="flex flex-col gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    {localize('com_ui_encryption_current_label')}
                  </label>
                  <input
                    type="password"
                    value={currentPass}
                    onChange={(e) => setCurrentPass(e.target.value)}
                    className="w-full rounded border border-border-medium bg-surface-primary px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    {localize('com_ui_encryption_new_label')}
                  </label>
                  <input
                    type="password"
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    className="w-full rounded border border-border-medium bg-surface-primary px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    {localize('com_ui_encryption_confirm_label')}
                  </label>
                  <input
                    type="password"
                    value={newPassConfirm}
                    onChange={(e) => setNewPassConfirm(e.target.value)}
                    className="w-full rounded border border-border-medium bg-surface-primary px-3 py-2 text-sm"
                  />
                </div>
                {changeError && <p className="text-sm text-red-500">{changeError}</p>}
              </div>
            }
            selection={{
              selectHandler: handleChangePassphrase,
              selectClasses: 'bg-blue-600 text-white hover:bg-blue-700',
              selectText: changeMutation.isLoading ? (
                <Spinner />
              ) : (
                localize('com_ui_encryption_change_button')
              ),
            }}
          />
        </OGDialog>
      </div>

      <div className="flex items-center justify-between">
        <Label>{localize('com_ui_encryption_reset_title')}</Label>
        <OGDialog open={resetOpen} onOpenChange={setResetOpen}>
          <OGDialogTrigger asChild>
            <Button variant="destructive" onClick={() => setResetOpen(true)}>
              {localize('com_ui_encryption_reset_button')}
            </Button>
          </OGDialogTrigger>
          <OGDialogTemplate
            showCloseButton={false}
            title={localize('com_ui_encryption_reset_title')}
            className="max-w-[450px]"
            main={
              <div className="flex flex-col gap-3">
                <p className="text-sm text-text-secondary">
                  {localize('com_ui_encryption_reset_warning')}
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={resetConfirm}
                    onChange={(e) => setResetConfirm(e.target.checked)}
                  />
                  {localize('com_ui_encryption_reset_confirm')}
                </label>
              </div>
            }
            selection={{
              selectHandler: handleResetEncryption,
              selectClasses:
                'bg-destructive text-white transition-all duration-200 hover:bg-destructive/80',
              selectText: resetMutation.isLoading ? (
                <Spinner />
              ) : (
                localize('com_ui_encryption_reset_button')
              ),
            }}
          />
        </OGDialog>
      </div>
    </div>
  );
}
