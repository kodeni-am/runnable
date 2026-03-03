import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

export default function AuthCallback() {
    const [searchParams] = useSearchParams();
    const { setTokens, loadUser } = useAuthStore();
    const navigate = useNavigate();

    useEffect(() => {
        const accessToken = searchParams.get('accessToken');
        const refreshToken = searchParams.get('refreshToken');

        if (accessToken && refreshToken) {
            setTokens(accessToken, refreshToken);
            loadUser().then(() => navigate('/'));
        } else {
            navigate('/login');
        }
    }, []);

    return (
        <div className="auth-page">
            <div className="spinner" style={{ width: 40, height: 40 }} />
        </div>
    );
}
