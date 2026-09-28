import { Inject } from '@nestjs/common';
import { Args, Query, Resolver, ResolveReference } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { InvalidInputError } from './cursor.ts';
import { JobsRepository, type Job, type JobConnection, type JobFilter } from './jobs.repository.ts';

async function asUserInput<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof InvalidInputError) {
      throw new GraphQLError(error.message, { extensions: { code: 'BAD_USER_INPUT' }, originalError: error });
    }
    throw error;
  }
}

@Resolver('Query')
export class JobsQueryResolver {
  constructor(@Inject(JobsRepository) private readonly jobs: JobsRepository) {}

  @Query('job')
  job(@Args('id') id: string): Promise<Job | null> {
    return this.jobs.findById(id);
  }

  @Query('jobs')
  list(
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Args('filter') filter: JobFilter | null,
  ): Promise<JobConnection> {
    return asUserInput(Promise.resolve().then(() => this.jobs.page({ first, after, filter })));
  }
}

@Resolver('Job')
export class JobEntityResolver {
  constructor(@Inject(JobsRepository) private readonly jobs: JobsRepository) {}

  @ResolveReference()
  resolveReference(reference: { __typename: 'Job'; id: string }): Promise<Job | null> {
    return this.jobs.findById(reference.id);
  }
}
