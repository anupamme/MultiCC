import 'dart:convert';
import 'package:http/http.dart' as http;

/// The conversation's source session is gone (its task was deleted on the
/// board or elsewhere). Unlike a network failure, retrying can never succeed.
class ChatSessionGoneException implements Exception {
  const ChatSessionGoneException(this.code);
  final String code;
  @override
  String toString() => 'ChatSessionGoneException($code)';
}

/// Keeps the visible conversation stable while its execution cursor moves.
class ChatShellView {
  ChatShellView(this.sourceSessionId);
  final String sourceSessionId;
  String? shellId;
  bool unsupported = false;
  Future<String?>? _opening;

  Future<String> prepare(
    Future<http.Response> Function(String path, String? body) request,
  ) async {
    if (unsupported || sourceSessionId.isEmpty) return sourceSessionId;
    if (shellId == null) {
      _opening ??= () async {
        final response = await request(
          '/api/task-shells',
          jsonEncode({'sessionId': sourceSessionId}),
        );
        final data = _decode(response);
        if (data['code'] == 'unsupported_source') {
          unsupported = true;
          return null;
        }
        _throwIfGone(response, data);
        if (response.statusCode != 200 || data['id'] is! String) {
          throw StateError('shell open failed: ${response.statusCode}');
        }
        return data['id'] as String;
      }();
      try {
        shellId = await _opening;
      } finally {
        _opening = null;
      }
      if (unsupported) return sourceSessionId;
    }
    final response = await request(
      '/api/task-shells/${Uri.encodeComponent(shellId!)}/chat',
      null,
    );
    final data = _decode(response);
    _throwIfGone(response, data);
    if (response.statusCode != 200 || data['activeSessionId'] is! String) {
      throw StateError('shell scope failed: ${response.statusCode}');
    }
    return data['activeSessionId'] as String;
  }

  static Map _decode(http.Response response) {
    try {
      final data = jsonDecode(utf8.decode(response.bodyBytes));
      return data is Map ? data : const {};
    } catch (_) {
      return const {};
    }
  }

  // 只认服务端明确说「源会话没了」的两种回答：409 source_session_missing
  // （任务壳还在、会话已删）和 404 session_not_found / Session not found
  // （连壳都开不出来）。其余失败照旧当临时故障重连。
  static void _throwIfGone(http.Response response, Map data) {
    final code = data['code']?.toString();
    if (response.statusCode == 409 && code == 'source_session_missing') {
      throw ChatSessionGoneException(code!);
    }
    if (response.statusCode == 404 &&
        (code == 'session_not_found' || data['error'] == 'Session not found')) {
      throw ChatSessionGoneException(code ?? 'session_not_found');
    }
  }

  String historyPath(String executionSessionId) => shellId == null
      ? '/api/sessions/${Uri.encodeComponent(executionSessionId)}/history'
      : '/api/task-shells/${Uri.encodeComponent(shellId!)}/history';

  Map<String, dynamic> record(Map<String, dynamic> message, String origin) {
    if (message['sourceSessionId'] != null || message['id'] == null) {
      return message;
    }
    return {
      ...message,
      'id': '$origin:${message['id']}',
      'sourceSessionId': origin,
      'sourceMessageId': message['id'],
    };
  }

  Map<String, dynamic> event(Map<String, dynamic> message, String active) {
    if (shellId == null) return message;
    final origin = message['sourceSessionId']?.toString() ?? active;
    switch (message['type']) {
      case 'chat_msg_meta':
        return {
          ...record(message, origin),
          if (message['message'] is Map)
            'message': record(
              Map<String, dynamic>.from(message['message']),
              origin,
            ),
        };
      case 'chat_history':
      case 'chat_history_reset':
      case 'shell_history_update':
      // Late task attribution addresses messages by their *execution-session*
      // id, but a shell bubble is keyed by the composite id. Running the
      // records through [record] here is what makes the two meet — without it
      // the annotation would name ids no bubble has and be dropped silently.
      case 'chat_history_annotation':
        return {
          ...message,
          'sourceSessionId': origin,
          'messages': [
            for (final m in message['messages'] as List? ?? [])
              record(Map<String, dynamic>.from(m), origin),
          ],
        };
      case 'chat_msg_deleted':
        return {...message, 'id': '$origin:${message['id']}'};
      default:
        return message;
    }
  }
}

({String sessionId, String messageId}) shellMessageOwner(
  String fallback,
  String id,
) {
  final separator = id.indexOf(':');
  return separator > 0
      ? (
          sessionId: id.substring(0, separator),
          messageId: id.substring(separator + 1),
        )
      : (sessionId: fallback, messageId: id);
}
