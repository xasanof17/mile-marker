import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { normalizeLocation } from '../middleware/normalizeLocation.js';
import { getNearestMilestone } from '../controllers/milestone.controller.js';

const router = Router();

const limiter = rateLimit({
  windowMs: 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
});

const validateLocation = [
  body('location')
    .exists({ checkNull: true })
    .withMessage('location field is required')
    .notEmpty()
    .withMessage('location must not be empty'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    next();
  },
];

router.post(
  '/nearest-milestone',
  limiter,
  validateLocation,
  normalizeLocation,
  getNearestMilestone
);

// GET support: move ?location= into req.body for the same pipeline
router.get(
  '/nearest-milestone',
  limiter,
  (req, _res, next) => { req.body = { location: req.query.location }; next(); },
  validateLocation,
  normalizeLocation,
  getNearestMilestone
);

export default router;
