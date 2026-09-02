/**
 * Vercel Speed Insights Configuration
 *
 * Note: Speed Insights is designed for client-side performance tracking in web
 * applications. This backend API does not serve HTML pages directly, so Speed
 * Insights cannot be integrated in the traditional sense.
 *
 * If you have a frontend application that consumes this API, you should
 * integrate Speed Insights there following the framework-specific instructions:
 *
 * - Next.js: Use `<SpeedInsights />` from '@vercel/speed-insights/next'
 * - React: Use `<SpeedInsights />` from '@vercel/speed-insights/react'
 * - Vue: Use `<SpeedInsights />` from '@vercel/speed-insights/vue'
 * - Other frameworks: See https://vercel.com/docs/speed-insights/quickstart
 *
 * This file serves as a placeholder to document the package installation.
 * The package is available in package.json and ready to use in any frontend
 * application that interfaces with this backend.
 */

/**
 * Speed Insights configuration options (for frontend integration)
 */
export interface SpeedInsightsConfig {
  /**
   * Whether to enable debug logging. Automatically enabled in development.
   */
  debug?: boolean;

  /**
   * Sample rate for events (0-1). Default is 1 (100% of events).
   * Set to 0.5 to send 50% of events, reducing costs.
   */
  sampleRate?: number;

  /**
   * The dynamic route of the page (e.g., '/blog/[slug]')
   * Used for aggregating metrics across similar routes.
   */
  route?: string | null;

  /**
   * Custom endpoint for sending metrics (for self-hosted deployments)
   */
  endpoint?: string;

  /**
   * Custom script source URL
   */
  scriptSrc?: string;

  /**
   * Middleware function to modify or filter events before sending
   */
  beforeSend?: (
    event: BeforeSendEvent,
  ) => BeforeSendEvent | null | undefined | false;
}

interface BeforeSendEvent {
  type: 'vital';
  url: string;
  route?: string;
}

/**
 * Example configuration for frontend applications
 */
export const defaultSpeedInsightsConfig: SpeedInsightsConfig = {
  // Debug mode automatically enabled in development
  debug: process.env.NODE_ENV !== 'production',

  // Send all events by default
  sampleRate: 1,
};
