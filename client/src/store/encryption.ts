import { atom } from 'jotai';

/** Whether the current user's encryption session is unlocked (UEK is cached on the server). */
const encryptionUnlocked = atom(false);

export default { encryptionUnlocked };
