import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

export default function AuthCallback() {
    const { loadUser } = useAuthStore();
    const navigate = useNavigate();

    useEffect(() => {
        // OAuth callback — cookies are already set by the server redirect
        // Just load the user and navigate home
        loadUser()
            .then(() => navigate('/'))
            .catch(() => navigate('/login'));
    }, []);

    return (
        <div className="auth-page">
            <div className="spinner" style={{ width: 40, height: 40 }} />
        </div>
    );
}
