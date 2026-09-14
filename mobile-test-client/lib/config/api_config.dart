/// Configuración del endpoint de la API del backend configurable en tiempo de ejecución.
/// Cumple con el requerimiento mobile:R4 (reorientación sin recompilar).
class ApiConfig {
  static const String defaultBaseUrl = 'http://localhost:8080';

  String _baseUrl;

  ApiConfig({String baseUrl = defaultBaseUrl}) : _baseUrl = _validateAndNormalize(baseUrl);

  String get baseUrl => _baseUrl;

  void updateBaseUrl(String newUrl) {
    _baseUrl = _validateAndNormalize(newUrl);
  }

  String get customersUrl => '$_baseUrl/api/customers';

  String customerByIdUrl(int id) => '$_baseUrl/api/customers/$id';

  String get assistantUrl => '$_baseUrl/api/assistant';

  static String _validateAndNormalize(String url) {
    if (url.trim().isEmpty) {
      throw ArgumentError('Base URL cannot be empty');
    }

    final uri = Uri.tryParse(url.trim());
    if (uri == null || (!uri.isScheme('http') && !uri.isScheme('https')) || uri.host.isEmpty) {
      throw ArgumentError('Invalid base URL: $url. Must start with http:// or https:// and include a host.');
    }

    // Eliminar barra inclinada final
    var normalized = url.trim();
    while (normalized.endsWith('/')) {
      normalized = normalized.substring(0, normalized.length - 1);
    }
    return normalized;
  }
}
