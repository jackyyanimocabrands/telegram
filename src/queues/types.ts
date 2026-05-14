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
  conversationId: string;  // 'child:{botId}:{userId}'
  botId: string;
  userId: number;
  chatId: number;
  messageId: number;
  text: string;
  // NOTE: botToken is NOT stored here; worker fetches from DB by botId
}
