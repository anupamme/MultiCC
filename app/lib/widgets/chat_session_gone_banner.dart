import 'package:flutter/material.dart';
import '../i18n.dart';

/// Shown when the conversation's task was deleted elsewhere (task board, web):
/// the chat can never reconnect, so say so and offer a way out instead of an
/// endless "Connecting…".
class ChatSessionGoneBanner extends StatelessWidget {
  final VoidCallback onClose;
  const ChatSessionGoneBanner({super.key, required this.onClose});

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('chat-session-gone-bar'),
      margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFFfdf1f0),
        border: Border.all(color: const Color(0xFFb4372f)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          const Icon(Icons.delete_outline, size: 16, color: Color(0xFFb4372f)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              t('chatSessionGone'),
              style: const TextStyle(color: Color(0xFFb4372f), fontSize: 12),
            ),
          ),
          TextButton(
            key: const Key('chat-session-gone-close'),
            onPressed: onClose,
            child: Text(t('chatSessionGoneClose')),
          ),
        ],
      ),
    );
  }
}
