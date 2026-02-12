import { Routes, Route, Navigate } from 'react-router'
import Auth from './pages/auth.tsx'
import Profile from './pages/profile.tsx'
// import Admin from './pages/admin.tsx'
// import Admincheck from './pages/admincheck.tsx'
import ProfilePay from './pages/profilepay.tsx'


function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/auth" replace />} />
      <Route path="/auth" element={<Auth />} />
      <Route path="/profile" element={<Profile />} />
      <Route path="/profile-pay" element={<ProfilePay />} />
      {/* <Route path="/about" element={<h1>About Page</h1>} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/admin-check" element={<Admincheck />} /> */}
    </Routes>
  )
}

export default App
