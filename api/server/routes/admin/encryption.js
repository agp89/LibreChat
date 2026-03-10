const express = require('express');
const mongoose = require('mongoose');
const { requireAdmin } = require('@librechat/api');
const middleware = require('~/server/middleware');

const router = express.Router();

/**
 * GET /api/admin/encryption/status
 * Returns encryption system status for admin dashboard.
 * Requires admin role.
 */
router.get('/status', middleware.requireJwtAuth, requireAdmin, async (req, res) => {
  try {
    const User = mongoose.models.User;
    if (!User) {
      return res.status(500).json({ error: 'User model not available' });
    }

    const totalUsers = await User.countDocuments();
    const encryptedUsers = await User.countDocuments({
      encryptionVersion: { $gte: 1 },
      encryptedUEK: { $exists: true, $ne: null },
    });

    const Message = mongoose.models.Message;
    const encryptedMessages = Message
      ? await Message.countDocuments({ encryptionVersion: { $gte: 1 } })
      : 0;
    const totalMessages = Message ? await Message.countDocuments() : 0;

    return res.status(200).json({
      enabled: process.env.ENCRYPT_USER_DATA === 'true',
      masterKeyConfigured: !!process.env.ENCRYPTION_MASTER_KEY,
      stats: {
        totalUsers,
        encryptedUsers,
        totalMessages,
        encryptedMessages,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
