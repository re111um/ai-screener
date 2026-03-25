import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx' // App.jsx 파일을 불러옴
import './index.css' // 만약 index.css가 없다면 이 줄은 지워도 됩니다.

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
