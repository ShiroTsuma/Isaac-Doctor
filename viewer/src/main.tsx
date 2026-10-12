import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './style.css';
const root = document.getElementById('root');
if (!root) {
  throw Error('Missing application root');
}
createRoot(root).render(<App />);
