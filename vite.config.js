import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './', // 이 부분이 './'로 되어 있어야 경로 오류가 나지 않습니다.
})
