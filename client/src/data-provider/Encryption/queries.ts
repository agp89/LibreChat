import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type {
  TEncryptionSaltResponse,
  TSetupEncryptionResponse,
  TUnlockEncryptionRequest,
  TUnlockEncryptionResponse,
  TChangePassphraseRequest,
  TChangePassphraseResponse,
  TResetEncryptionRequest,
  TResetEncryptionResponse,
  MutationOptions,
} from 'librechat-data-provider';

/** Fetches the user's PBKDF2 salt for client-side sessionSecret derivation. */
export const useGetEncryptionSaltQuery = (): UseQueryResult<TEncryptionSaltResponse> =>
  useQuery<TEncryptionSaltResponse>({
    queryKey: [QueryKeys.encryptionSalt],
    queryFn: () => dataService.getEncryptionSalt(),
    retry: false,
  });

/** Sets up encryption for a user (first-time passphrase setup). */
export const useSetupEncryptionMutation = (
  options?: MutationOptions<TSetupEncryptionResponse, undefined>,
): UseMutationResult<TSetupEncryptionResponse, unknown, undefined, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.setupEncryption], {
    mutationFn: () => dataService.setupEncryption(),
    ...(options || {}),
    onSuccess: (data, ...args) => {
      queryClient.invalidateQueries([QueryKeys.encryptionSalt]);
      options?.onSuccess?.(data, ...args);
    },
  });
};

/** Unlocks encryption for the current session by providing the sessionSecret. */
export const useUnlockEncryptionMutation = (
  options?: MutationOptions<TUnlockEncryptionResponse, TUnlockEncryptionRequest>,
): UseMutationResult<TUnlockEncryptionResponse, unknown, TUnlockEncryptionRequest, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.unlockEncryption], {
    mutationFn: (payload: TUnlockEncryptionRequest) => dataService.unlockEncryption(payload),
    ...(options || {}),
    onSuccess: (data, ...args) => {
      queryClient.invalidateQueries([QueryKeys.encryptionStatus]);
      options?.onSuccess?.(data, ...args);
    },
  });
};

/** Changes the user's encryption passphrase. */
export const useChangeEncryptionPassphraseMutation = (
  options?: MutationOptions<TChangePassphraseResponse, TChangePassphraseRequest>,
): UseMutationResult<TChangePassphraseResponse, unknown, TChangePassphraseRequest, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.changeEncryptionPassphrase], {
    mutationFn: (payload: TChangePassphraseRequest) =>
      dataService.changeEncryptionPassphrase(payload),
    ...(options || {}),
    onSuccess: (data, ...args) => {
      queryClient.invalidateQueries([QueryKeys.encryptionSalt]);
      options?.onSuccess?.(data, ...args);
    },
  });
};

/** Resets encryption — permanently deletes all encrypted user data. */
export const useResetEncryptionMutation = (
  options?: MutationOptions<TResetEncryptionResponse, TResetEncryptionRequest>,
): UseMutationResult<TResetEncryptionResponse, unknown, TResetEncryptionRequest, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.resetEncryption], {
    mutationFn: (payload: TResetEncryptionRequest) => dataService.resetEncryption(payload),
    ...(options || {}),
    onSuccess: (data, ...args) => {
      queryClient.invalidateQueries([QueryKeys.encryptionSalt]);
      queryClient.invalidateQueries([QueryKeys.encryptionStatus]);
      options?.onSuccess?.(data, ...args);
    },
  });
};
