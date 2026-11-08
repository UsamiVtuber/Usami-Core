import React from 'react';

// Fronteira de erro dedicada ao palco/canvas (F23). O ErrorBoundary global
// continua cobrindo o app inteiro; aqui o fallback fica DENTRO do palco, com
// botão para remontar o avatar sem recarregar a página.
export class StageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[Usami palco] falha ao renderizar o avatar:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
    this.props.onRetry?.();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="stage-fallback" role="alert">
        <p>O palco do avatar travou.</p>
        <span>{this.state.error?.message || 'Erro inesperado ao montar a cena 3D.'}</span>
        <button type="button" onClick={this.handleRetry}>Recarregar modelo</button>
      </div>
    );
  }
}
