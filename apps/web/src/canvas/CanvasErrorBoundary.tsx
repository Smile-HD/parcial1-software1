import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * ErrorBoundary para el lienzo de diagramas UML.
 * Evita que errores de renderizado en React Flow o extensiones provoquen pantalla en blanco.
 */
export class CanvasErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Canvas rendering error caught by CanvasErrorBoundary:', error, errorInfo);
  }

  public handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  public override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          className="canvas-error-boundary"
          data-testid="canvas-error-boundary"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: '32px',
            backgroundColor: '#f8fafc',
            color: '#1e293b',
            fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              padding: '24px 32px',
              backgroundColor: '#ffffff',
              borderRadius: '8px',
              border: '1.5px solid #cbd5e1',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
              maxWidth: '480px',
            }}
          >
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '18px', fontWeight: 600 }}>
              Error al renderizar el lienzo
            </h3>
            <p style={{ margin: '0 0 16px 0', fontSize: '13px', color: '#64748b' }}>
              Ocurrió un error inesperado al actualizar el diagrama. Podés recargar el visor para continuar sin perder tu progreso.
            </p>
            {this.state.error && (
              <pre
                style={{
                  margin: '0 0 16px 0',
                  padding: '8px 12px',
                  backgroundColor: '#f1f5f9',
                  borderRadius: '4px',
                  fontSize: '11px',
                  textAlign: 'left',
                  maxHeight: '80px',
                  overflowY: 'auto',
                  color: '#dc2626',
                }}
              >
                {this.state.error.message}
              </pre>
            )}
            <button
              type="button"
              onClick={this.handleReset}
              data-testid="canvas-error-reset"
              style={{
                padding: '8px 16px',
                backgroundColor: '#2563eb',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Recargar lienzo
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
