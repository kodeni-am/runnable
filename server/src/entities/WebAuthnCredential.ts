import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { User } from './User';

@Entity('webauthn_credentials')
export class WebAuthnCredential {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => User, (user) => user.passkeys, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column({ type: 'uuid' })
    userId: string;

    /** Base64url credential ID as produced by the authenticator. */
    @Index({ unique: true })
    @Column({ type: 'text' })
    credentialId: string;

    /** Base64url-encoded COSE public key. */
    @Column({ type: 'text' })
    publicKey: string;

    /**
     * WebAuthn signature counter. Postgres bigint comes back through
     * TypeORM as a string; parsed at the point of use.
     */
    @Column({ type: 'bigint', default: 0 })
    counter: string;

    @Column({ type: 'simple-json', nullable: true })
    transports?: string[];

    @Column({ default: 'singleDevice' })
    deviceType: string;

    @Column({ default: false })
    backedUp: boolean;

    /** User-supplied label, e.g. "MacBook Touch ID". */
    @Column({ length: 64 })
    name: string;

    @CreateDateColumn()
    createdAt: Date;

    @Column({ type: 'timestamp', nullable: true })
    lastUsedAt?: Date | null;
}
