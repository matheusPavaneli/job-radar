import { join } from 'node:path';
import { ApolloServerPluginInlineTraceDisabled } from '@apollo/server/plugin/disabled';
import { ApolloFederationDriver, type ApolloFederationDriverConfig } from '@nestjs/apollo';
import { type DynamicModule, Inject, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { GraphQLScalarType, Kind } from 'graphql';
import type postgres from 'postgres';
import { internalAuthMiddleware } from './internal-auth.middleware.ts';
import { JobsRepository } from './jobs.repository.ts';
import { JobEntityResolver, JobsQueryResolver } from './jobs.resolver.ts';

export interface AppOptions {
  sql: postgres.Sql;
  internalAuthSecret: string;
  nowSeconds?: () => number;
}

const APP_OPTIONS = Symbol('APP_OPTIONS');
const SCHEMA_PATH = join(import.meta.dirname, '..', 'schema.graphql');

const DateTime = new GraphQLScalarType<Date, string>({
  name: 'DateTime',
  serialize(value) {
    if (value instanceof Date) return value.toISOString();
    throw new TypeError('DateTime must be a Date');
  },
  parseValue(value) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError('DateTime must be ISO 8601');
    return new Date(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING || Number.isNaN(Date.parse(ast.value))) throw new TypeError('DateTime must be ISO 8601');
    return new Date(ast.value);
  },
});

@Module({})
export class AppModule implements NestModule {
  constructor(@Inject(APP_OPTIONS) private readonly options: AppOptions) {}

  static register(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        GraphQLModule.forRoot<ApolloFederationDriverConfig>({
          driver: ApolloFederationDriver,
          typePaths: [SCHEMA_PATH],
          resolvers: { DateTime },
          plugins: [ApolloServerPluginInlineTraceDisabled()],
        }),
      ],
      providers: [
        { provide: APP_OPTIONS, useValue: options },
        { provide: JobsRepository, useValue: new JobsRepository(options.sql) },
        JobsQueryResolver,
        JobEntityResolver,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(internalAuthMiddleware(this.options.internalAuthSecret, this.options.nowSeconds))
      .forRoutes('*path');
  }
}
