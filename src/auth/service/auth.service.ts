/* eslint-disable @typescript-eslint/no-unused-vars */
import { Response } from 'express';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role, User } from '@prisma/client';
import { hash, verify } from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto, SignupDto, AuthRequest, Tokens, JwtPayload } from '../';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private jwt: JwtService,
  ) {} // Injecting dependecies

  async signup(dto: SignupDto) {
    const hashedPassword = await hash(dto.password);

    try {
      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          password: hashedPassword,
          name: dto.name,
        },
      });

      const { password, refreshToken, createdAt, updatedAt, ...restOfUser } =
        user;

      return { user: restOfUser };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException(['Email is already in use']);
        }
      }

      throw error;
    }
  }

  async login(dto: LoginDto, res: Response) {
    const ERROR = 'Email or password incorrect.';

    try {
      const user = await this.prisma.user.findFirstOrThrow({
        where: { email: dto.email },
      });

      const passwordMatch = await verify(user.password, dto.password);

      if (!passwordMatch) {
        throw new BadRequestException(ERROR);
      }

      const tokens = await this.getTokens(user.id, user.email, user.role);
      await this.updateRtHash(user.id, tokens.refresh_token);

      this.saveTokensInCookies(res, tokens);

      const { password, refreshToken, createdAt, updatedAt, ...restOfUser } =
        user;

      return { user: restOfUser, tokens };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025') {
          throw new UnauthorizedException(ERROR);
        }
      }

      throw error;
    }
  }

  async logout(userId: number, res: Response): Promise<boolean> {
    try {
      await this.prisma.user.updateMany({
        where: {
          id: userId,
          refreshToken: { not: null },
        },
        data: { refreshToken: null },
      });

      this.removeTokensInCookies(res);

      return true;
    } catch (error) {
      throw error;
    }
  }

  async refreshTokens(
    res: Response,
    userId: number,
    rt: string,
  ): Promise<{ user: Partial<User>; tokens: Tokens }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        refreshToken: true,
      },
    });

    if (!user || !user.refreshToken) {
      throw new ForbiddenException('Access Denied.');
    }

    const rtMatches = await verify(user.refreshToken, rt);

    if (!rtMatches) throw new ForbiddenException('Access Denied.');

    const tokens = await this.getTokens(user.id, user.email, user.role);
    await this.updateRtHash(user.id, tokens.refresh_token);

    this.saveTokensInCookies(res, tokens);

    const { refreshToken, ...restOfUser } = user;

    return {
      user: restOfUser,
      tokens,
    };
  }

  async googleAuthCallback(req: AuthRequest, res: Response) {
    const { id, email, role } = req.user;

    const tokens = await this.getTokens(id, email, role);

    if (!tokens) {
      return res.redirect(this.config.get('CLIENT_ORIGIN'));
    }

    await this.updateRtHash(id, tokens.refresh_token);

    res.cookie('test', 'hola', {
      // httpOnly: true,
      // expires: new Date(new Date().getTime() + 15 * 60 * 1000),
    });

    this.saveTokensInCookies(res, tokens);
  }

  async updateRtHash(userId: number, rt: string): Promise<void> {
    const hashedRefreshToken = await hash(rt);

    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken: hashedRefreshToken },
    });
  }

  async getTokens(userId: number, email: string, role: Role): Promise<Tokens> {
    const jwtPayload: JwtPayload = {
      sub: userId,
      role,
      email,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(jwtPayload, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
        expiresIn: '15m',
      }),
      this.jwt.signAsync(jwtPayload, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      }),
    ]);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  saveTokensInCookies(res: Response, tokens: Tokens) {
    const { access_token, refresh_token } = tokens;

    res.cookie('ACCESS_TOKEN', access_token, {
      maxAge: 900000, // 15m
      // httpOnly: true,
      // expires: new Date(new Date().getTime() + 15 * 60 * 1000),
    });

    res.cookie('REFRESH_TOKEN', refresh_token, {
      maxAge: 604800000, // 1w
      // httpOnly: true,
      // expires: new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000), // 1w
    });
  }

  removeTokensInCookies(res: Response) {
    res.cookie('ACCESS_TOKEN', '', {
      maxAge: 0,
    });

    res.cookie('REFRESH_TOKEN', '', {
      maxAge: 0,
    });
  }
}
