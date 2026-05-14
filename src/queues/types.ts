export interface ManagerMessageJobData {
  conversationId: string;  // 'manager:{userId}'
  userId: number;
  chatId: number;
  messageId: number;
  text: string;
  firstName: string;
  username?: string;
}

export interface ChildMessageJobData {
  conversationId: string;
  botId: string;
  userId: number;
  chatId: number;
  messageId: number;
  text: string;
  firstName: string;
  username?: string;
}

export interface EmailVerificationNotificationJobData {
  botId: string;
  userId: number;
  chatId: number;
  jti: string;
}
