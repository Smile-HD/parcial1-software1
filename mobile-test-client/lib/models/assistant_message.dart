/// Carga útil de solicitud para POST /api/assistant.
class AssistantRequest {
  final String request;

  AssistantRequest(this.request);

  Map<String, dynamic> toJson() => {
        'request': request,
      };
}

/// Carga útil de respuesta devuelta por POST /api/assistant.
/// Se ajusta al diseño D11 y al requerimiento mobile:R3.
class AssistantResponse {
  final String outcome; // executed | canned | unavailable | refused
  final String? action;  // list | count | create | null
  final String? entity;  // Customer | null
  final String response; // Cuerpo del resultado o mensaje de capacidad predefinido

  AssistantResponse({
    required this.outcome,
    this.action,
    this.entity,
    required this.response,
  });

  factory AssistantResponse.fromJson(Map<String, dynamic> json) {
    return AssistantResponse(
      outcome: json['outcome'] as String? ?? 'canned',
      action: json['action'] as String?,
      entity: json['entity'] as String?,
      response: json['response'] as String? ?? '',
    );
  }

  bool get isExecuted => outcome == 'executed';
  bool get isCanned => outcome == 'canned';
  bool get isUnavailable => outcome == 'unavailable';
  bool get isRefused => outcome == 'refused';

  @override
  String toString() =>
      'AssistantResponse(outcome: $outcome, action: $action, entity: $entity, response: $response)';
}
