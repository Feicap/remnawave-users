import { Routes, Route, Navigate } from 'react-router'
import Auth from './pages/auth.tsx'
import Profile from './pages/profile.tsx'
import ProfilePay from './pages/profilepay.tsx'
import Admin from './pages/admin.tsx'


function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/auth" replace />} />
      <Route path="/auth" element={<Auth />} />
      <Route path="/profile" element={<Profile />} />
      <Route path="/profile-pay" element={<ProfilePay />} />
      <Route path="/admin" element={<Admin />} />
    </Routes>
  )
}

export default App
