const mongoose = require('mongoose');
const {
  getEncryptionSalt,
  setupEncryption,
  unlockEncryption,
  changePassphrase,
  resetEncryption,
  userKeyCache,
  encryptionStore,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

const ENCRYPTION_ENABLED = process.env.ENCRYPT_USER_DATA === 'true';

/** GET /api/auth/encryption-salt */
const getEncryptionSaltController = async (req, res) => {
  if (!ENCRYPTION_ENABLED) {
    return res.status(404).json({ error: 'encryption_not_configured' });
  }
  try {
    const result = await getEncryptionSalt(mongoose, String(req.user.id));
    return res.status(200).json(result);
  } catch (err) {
    if (err.code === 'encryption_not_configured') {
      return res.status(404).json({ error: err.code });
    }
    logger.error('[getEncryptionSaltController]', err);
    return res.status(500).json({ message: err.message });
  }
};

/** POST /api/auth/setup-encryption */
const setupEncryptionController = async (req, res) => {
  if (!ENCRYPTION_ENABLED) {
    return res.status(404).json({ error: 'encryption_not_enabled' });
  }
  try {
    const result = await setupEncryption(mongoose, String(req.user.id));
    return res.status(200).json(result);
  } catch (err) {
    if (err.code === 'encryption_already_configured') {
      return res.status(409).json({ error: err.code });
    }
    logger.error('[setupEncryptionController]', err);
    return res.status(500).json({ message: err.message });
  }
};

/** POST /api/auth/unlock-encryption */
const unlockEncryptionController = async (req, res) => {
  if (!ENCRYPTION_ENABLED) {
    return res.status(404).json({ error: 'encryption_not_enabled' });
  }
  const { sessionSecret } = req.body;
  if (!sessionSecret || typeof sessionSecret !== 'string' || sessionSecret.length !== 64) {
    return res.status(400).json({ error: 'invalid_session_secret' });
  }
  try {
    const result = await unlockEncryption(mongoose, String(req.user.id), { sessionSecret });
    return res.status(200).json(result);
  } catch (err) {
    if (err.code === 'invalid_passphrase') {
      return res.status(401).json({ error: err.code });
    }
    if (err.code === 'passphrase_rate_limited') {
      return res.status(429).json({ error: err.code, retryAfter: err.retryAfter });
    }
    logger.error('[unlockEncryptionController]', err);
    return res.status(500).json({ message: err.message });
  }
};

/** POST /api/auth/change-passphrase */
const changePassphraseController = async (req, res) => {
  if (!ENCRYPTION_ENABLED) {
    return res.status(404).json({ error: 'encryption_not_enabled' });
  }
  const { oldSessionSecret, newSessionSecret } = req.body;
  if (
    !oldSessionSecret ||
    typeof oldSessionSecret !== 'string' ||
    oldSessionSecret.length !== 64 ||
    !newSessionSecret ||
    typeof newSessionSecret !== 'string' ||
    newSessionSecret.length !== 64
  ) {
    return res.status(400).json({ error: 'invalid_session_secrets' });
  }
  try {
    const result = await changePassphrase(mongoose, String(req.user.id), {
      oldSessionSecret,
      newSessionSecret,
    });
    return res.status(200).json(result);
  } catch (err) {
    if (err.code === 'invalid_passphrase') {
      return res.status(401).json({ error: err.code });
    }
    if (err.code === 'encryption_not_configured') {
      return res.status(404).json({ error: err.code });
    }
    logger.error('[changePassphraseController]', err);
    return res.status(500).json({ message: err.message });
  }
};

/** POST /api/auth/reset-encryption */
const resetEncryptionController = async (req, res) => {
  if (!ENCRYPTION_ENABLED) {
    return res.status(404).json({ error: 'encryption_not_enabled' });
  }
  const { confirm } = req.body;
  try {
    const result = await resetEncryption(mongoose, String(req.user.id), { confirm: !!confirm });
    return res.status(200).json(result);
  } catch (err) {
    if (err.code === 'confirmation_required') {
      return res.status(400).json({ error: err.code });
    }
    logger.error('[resetEncryptionController]', err);
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Express middleware that populates the AsyncLocalStorage encryption context for
 * each authenticated request that has an active (unlocked) encryption session.
 *
 * Must be mounted after requireJwtAuth so req.user is available.
 */
const encryptionContextMiddleware = (req, res, next) => {
  if (!ENCRYPTION_ENABLED || !req.user) return next();
  const userId = String(req.user.id);
  const uek = userKeyCache.getUEK(userId);
  if (!uek) return next();
  encryptionStore.run({ uek, userId }, next);
};

/**
 * Express middleware that returns 403 `encryption_locked` when the user has
 * set up encryption but their UEK is not currently cached (session expired
 * or not yet unlocked). This signals the frontend to re-prompt for the
 * passphrase (PRD §8.2).
 *
 * Skipped for:
 *  - Requests when ENCRYPT_USER_DATA is false
 *  - Unauthenticated requests (no req.user)
 *  - Users who have not yet set up encryption (encryptionVersion !== 1)
 */
const requireEncryptionUnlock = async (req, res, next) => {
  if (!ENCRYPTION_ENABLED || !req.user) return next();
  const userId = String(req.user.id);
  const uek = userKeyCache.getUEK(userId);
  if (uek) return next();

  // Check if user has encryption configured (has a wrapped UEK)
  try {
    const User = require('mongoose').models.User;
    if (!User) return next();
    const user = await User.findById(userId).select('encryptionVersion').lean();
    if (!user || user.encryptionVersion !== 1) return next();
  } catch {
    return next();
  }

  return res.status(403).json({ error: 'encryption_locked' });
};

module.exports = {
  getEncryptionSaltController,
  setupEncryptionController,
  unlockEncryptionController,
  changePassphraseController,
  resetEncryptionController,
  encryptionContextMiddleware,
  requireEncryptionUnlock,
};
