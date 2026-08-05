import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { Github, Mail, KeyRound } from 'lucide-react';
import { usePageTitle } from '../hooks/usePageTitle';
import { useRegistrationOpen } from '../hooks/useRegistrationOpen';

export default function Login() {
    usePageTitle('Login');
    const registrationOpen = useRegistrationOpen();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [searchParams] = useSearchParams();
    // Surface OAuth failures the server bounces back here (e.g. a blocked
    // login-CSRF attempt or expired flow)
    const [error, setError] = useState(
        searchParams.get('error') === 'oauth_state_mismatch'
            ? 'The sign-in attempt could not be verified. Please try again.'
            : ''
    );
    const { login, loginWithPasskey, isLoading } = useAuthStore();
    const navigate = useNavigate();

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        try {
            await login(email, password);
            navigate('/');
        } catch (err: any) {
            setError(err.response?.data?.error || 'Login failed');
        }
    };

    const handlePasskeyLogin = async () => {
        setError('');
        try {
            await loginWithPasskey();
            navigate('/');
        } catch (err: any) {
            // User dismissed the browser prompt — not an error worth showing
            if (err?.name === 'NotAllowedError' || err?.code === 'ERROR_CEREMONY_ABORTED') return;
            setError(err.response?.data?.error || 'Passkey sign-in failed');
        }
    };

    return (
        <div className="auth-page">
            <div className="auth-card glass">
                <h1 className="gradient-text">Welcome back</h1>
                <p>Sign in to your Runnable account</p>

                {error && <div className="alert alert-error">{error}</div>}

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label>Email</label>
                        <input
                            type="email"
                            className="form-input"
                            placeholder="you@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label>Password</label>
                        <input
                            type="password"
                            className="form-input"
                            placeholder="••••••••"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>
                    <button type="submit" className="btn btn-primary btn-full" disabled={isLoading}>
                        {isLoading ? <span className="spinner" /> : 'Sign In'}
                    </button>
                </form>

                <div className="oauth-divider">or continue with</div>

                <div className="oauth-buttons">
                    <a href="/api/auth/github" className="btn btn-secondary">
                        <Github size={18} />
                        GitHub
                    </a>
                    <a href="/api/auth/google" className="btn btn-secondary">
                        <Mail size={18} />
                        Google
                    </a>
                </div>

                {!!window.PublicKeyCredential && (
                    <button
                        type="button"
                        onClick={handlePasskeyLogin}
                        className="btn btn-secondary btn-full"
                        style={{ marginTop: 12 }}
                        disabled={isLoading}
                    >
                        <KeyRound size={18} />
                        Sign in with a passkey
                    </button>
                )}

                {/* Closed instances hide signup entirely rather than offering a
                    link to a page that only says no. */}
                {registrationOpen && (
                    <p style={{ textAlign: 'center', marginTop: 24, fontSize: 14 }}>
                        Don't have an account? <Link to="/register" style={{ color: 'var(--accent)' }}>Sign up</Link>
                    </p>
                )}
            </div>
        </div>
    );
}
