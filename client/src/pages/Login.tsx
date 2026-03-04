import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { Github, Mail } from 'lucide-react';
import { usePageTitle } from '../hooks/usePageTitle';

export default function Login() {
    usePageTitle('Login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const { login, isLoading } = useAuthStore();
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

                <p style={{ textAlign: 'center', marginTop: 24, fontSize: 14 }}>
                    Don't have an account? <Link to="/register" style={{ color: 'var(--accent)' }}>Sign up</Link>
                </p>
            </div>
        </div>
    );
}
