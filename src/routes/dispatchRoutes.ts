import { Router } from 'express';
import { dispatchController } from '../controllers/dispatchController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.use(mobileAuth);

router.post('/drafts', dispatchController.saveDraft);
router.get('/drafts', dispatchController.getLatestDrafts);
router.post('/drafts/:draftId/version', dispatchController.createNewVersion);
router.post('/drafts/:draftId/feedback', dispatchController.addFeedback);
router.get('/drafts/:draftId/feedback', dispatchController.getFeedbackHistory);
router.patch('/drafts/:draftId/status', dispatchController.updateStatus);
router.get('/drafts/root/:rootId/history', dispatchController.getDraftHistory);
router.post('/drafts/:draftId/dispatch', dispatchController.dispatch);

export default router;
