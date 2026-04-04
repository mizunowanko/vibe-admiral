/**
 * No-op handlers for message types handled by other hooks.
 *
 * Commander messages (flagship/dock) are handled by useCommander.
 * Component-specific messages (issue:data, fs:dir-listing) are handled
 * by their respective components via direct wsClient subscriptions.
 *
 * These handlers exist to satisfy the exhaustive MessageHandlerMap type.
 */
import type { MessageHandler } from "./handler-types";

export const handleFlagshipStream: MessageHandler<"flagship:stream"> = () => {};
export const handleFlagshipQuestion: MessageHandler<"flagship:question"> = () => {};
export const handleFlagshipQuestionTimeout: MessageHandler<"flagship:question-timeout"> = () => {};
export const handleDockStream: MessageHandler<"dock:stream"> = () => {};
export const handleDockQuestion: MessageHandler<"dock:question"> = () => {};
export const handleDockQuestionTimeout: MessageHandler<"dock:question-timeout"> = () => {};
export const handleIssueData: MessageHandler<"issue:data"> = () => {};
export const handleFsDirListing: MessageHandler<"fs:dir-listing"> = () => {};
