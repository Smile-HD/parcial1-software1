/// Explicit exception thrown when the backend cannot be reached.
/// Meets requirement mobile:R2:
/// "GIVEN the generated backend is not running,
///  WHEN the client attempts a request,
///  THEN the client shows an explicit connection error,
///  AND it MUST NOT display stale data as if it were live."
class BackendConnectionException implements Exception {
  final String message;
  final dynamic cause;

  BackendConnectionException(this.message, [this.cause]);

  @override
  String toString() => 'BackendConnectionException: $message';
}

/// Thrown when backend returns a client or server error (e.g. 400, 404, 500).
class BackendApiException implements Exception {
  final int statusCode;
  final String message;

  BackendApiException(this.statusCode, this.message);

  @override
  String toString() => 'BackendApiException ($statusCode): $message';
}
