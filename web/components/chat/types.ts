export interface ChatBubble {
  id: string;
  role: string;
  text: string;
}

export interface ChatBubble {
  id: string;
  role: 'user' | 'assistant' | 'draft';
  text: string;
  isVoice?: boolean; // ← add this
}
