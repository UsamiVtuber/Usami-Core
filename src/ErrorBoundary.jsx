import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[Usami ErrorBoundary caught error]:', error, errorInfo);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: '#0B132B',
          color: '#F9F9FB',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '24px',
          textAlign: 'center'
        }}>
          <h2 style={{ marginBottom: '12px', fontSize: '1.4rem' }}>Ops! Algo deu errado ao carregar a Usami.</h2>
          <p style={{
            maxWidth: '500px',
            color: '#C9CFDA',
            fontSize: '0.95rem',
            marginBottom: '20px',
            lineHeight: 1.5,
            wordBreak: 'break-word',
            background: 'rgba(249,249,251,0.05)',
            padding: '12px 16px',
            borderRadius: '8px'
          }}>
            {this.state.error?.message || 'Erro inesperado durante a execução.'}
          </p>
          <button
            onClick={this.handleReload}
            style={{
              padding: '10px 22px',
              backgroundColor: '#FF6B7A',
              color: '#F9F9FB',
              border: 'none',
              borderRadius: '24px',
              fontSize: '1rem',
              fontWeight: 'bold',
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(255, 107, 122, 0.3)'
            }}
          >
            Recarregar Usami
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
