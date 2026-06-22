import { Router } from 'express';
import { userSettingsController } from '../controllers/userSettingsController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

// Get all user settings
router.get('/', mobileAuth, userSettingsController.getSettings);

// Save/upsert user settings
router.put('/', mobileAuth, userSettingsController.saveSettings);

// Update a single settings field
router.patch('/:field', mobileAuth, userSettingsController.updateField);

// Full bulk sync from client
router.post('/sync', mobileAuth, userSettingsController.bulkSync);

// Hydrate settings on login
router.get('/hydrate', mobileAuth, userSettingsController.hydrateOnLogin);

export default router;