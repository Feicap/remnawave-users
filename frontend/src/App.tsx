import { Routes, Route, Navigate } from 'react-router'
import Auth from './pages/auth.tsx'
import CreateAccount from './pages/create-account.tsx'
import Profile from './pages/profile.tsx'
import ProfileSettings from './pages/profile-settings.tsx'
import ProfilePay from './pages/profilepay.tsx'
import Chat from './pages/chat.tsx'
import Admin from './pages/admin.tsx'
import AdminCheck from './pages/admincheck.tsx'


function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/auth" replace />} />
      <Route path="/auth" element={<Auth />} />
      <Route path="/auth/create-account" element={<CreateAccount />} />
      <Route path="/profile" element={<Profile />} />
      <Route path="/profile-settings" element={<ProfileSettings />} />
      <Route path="/profile-pay" element={<ProfilePay />} />
      <Route path="/chat" element={<Chat />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/admin-check" element={<AdminCheck />} />
    </Routes>
  )
}

export default App
