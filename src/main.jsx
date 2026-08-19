import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// NOTA: NO usamos <React.StrictMode>. En desarrollo React monta, desmonta y
// re-monta cada componente, lo que dispara el efecto de reproducción del Player
// dos veces seguidas; cada montura abre un stream continuo al panel (mpegts/HLS)
// y, como la conexión anterior tarda un instante en cerrarse en el proxy, el
// panel xui llega a contar 2-3 conexiones "simultáneas" al abrir un canal
// (exactamente el patrón que reportan los usuarios). StricMode es solo para
// desarrollo y no aporta nada para esta app TV-first; al quitarlo el arranque
// abre UNA sola conexión.
createRoot(document.getElementById('root')).render(<App />);
