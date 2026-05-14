export interface ManagerMessageJobData {
  conversationId: string;  // 'manager:{userId}'
  userId: number;
  chatId: number;
  messageId: number;
  text: string;
  firstName: string;
  username?: string;
}
