/**
 * The transactional email templates (subject + body) per the Ralia comms spec.
 * The body may contain blank-line-separated paragraphs; the dispatcher splits
 * them for the branded layout. The call-to-action button is resolved separately
 * from the notification type in notification-links.ts.
 *
 * `app` (CLIENT | PROMOTER) is carried on the notification data so account-level
 * messages (suspend/reactivate) link the recipient to the right application.
 */
import { Prisma } from '@prisma/client';

export type Template = { type: string; title: string; body: string; data?: Prisma.InputJsonValue };

export const templates = {
  welcomePromoter: (): Template => ({
    type: 'welcome.promoter',
    title: 'Welcome to Ralia!',
    body:
      'You can now earn by sharing campaigns, creating content, completing tasks or simply helping businesses reach more people.\n\n' +
      'New opportunities will start appearing in your dashboard as you complete onboarding.',
  }),

  welcomeClient: (): Template => ({
    type: 'welcome.client',
    title: 'Welcome to Ralia!',
    body:
      'My name is Victory Esele, and I am the Head of Ralia. We built Ralia because great businesses like yours deserve to reach the right people.\n\n' +
      'Ralia gives you a simple way to get people to promote your campaign — talking about your business, creating content for your product, sharing it, generating engagement, and completing assigned tasks both online and on the ground.\n\n' +
      'Your account is ready.\n\n' +
      'With best regards,\nVictory Esele\nHead of Ralia',
  }),

  accountSuspended: (app: 'CLIENT' | 'PROMOTER'): Template => ({
    type: 'account.suspended',
    title: 'Your account has been suspended',
    body:
      'Your Ralia account has been temporarily suspended following a review of your account activity.\n\n' +
      'If you believe this was a mistake, please contact us via email or on our WhatsApp chat support.',
    data: { app },
  }),

  accountReactivated: (app: 'CLIENT' | 'PROMOTER'): Template => ({
    type: 'account.reactivated',
    title: 'Your account has been successfully reactivated!',
    body: 'Your Ralia account has been reviewed and reactivated.\n\nYou can now sign in and continue using Ralia.',
    data: { app },
  }),

  campaignLive: (campaignId: string, campaignName: string): Template => ({
    type: 'campaign.live',
    title: 'Your campaign is live!',
    body:
      `Your campaign “${campaignName}” has been approved and is now live on Ralia.\n\n` +
      'Promoters can now spread your message. You can track campaign activity from your dashboard.',
    data: { campaignId },
  }),

  campaignComplete: (campaignId: string, campaignName: string): Template => ({
    type: 'campaign.fulfilled',
    title: 'Your campaign is complete',
    body: `Your campaign “${campaignName}” is now complete.\n\nYour results and activity summary are ready to review.`,
    data: { campaignId },
  }),

  payoutSuccessful: (amountDisplay: string): Template => ({
    type: 'payout.successful',
    title: 'Your Ralia payout is successful!',
    body: `Your payout of ${amountDisplay} has been successfully sent to your account.`,
  }),
};
