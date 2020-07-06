/* jshint esversion: 8 */
(function () {
    'use strict';

    var moment = require('moment');
    
    const interestingRepos = ['racket', 'ChezScheme', 'redex', 'typed-racket', 'drracket', 'scribble', 'plot'];
    
    const Octokit = require('@octokit/rest');
    const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN,
	throttle: {
	    onRateLimit: (retryAfter, options) => {
		octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`);

		if (options.request.retryCount === 0) { // only retries once
		    console.log(`Retrying after ${retryAfter} seconds!`);
		    return true;
		}
	    },
	    onAbuseLimit: (retryAfter, options) => {
		// does not retry, only logs a warning
		octokit.log.warn(`Abuse detected for request ${options.method} ${options.url}`);
	    }
	}
    });
    
    function countIssues(repo, rangeStart, rangeEnd) {
	// returns object of the form
	// { 'issues' : [<new>, <closed>, <current>]
	//   'prs'    : [<new>, <closed>, <current>] }
	const options = octokit.issues.listForRepo.endpoint.merge({
	    owner: 'racket',
	    repo: repo,
	    state: 'all',
	});
	return octokit.paginate(options)
	    .then(issues => {
		// Going through all issues;
		var inew = 0, iclosed = 0, icurrent = 0;
		var pnew = 0, pclosed = 0, pcurrent = 0;
		// getting the merged pulls is not as easy as I thought
		// one needs to issue a request for the pull, which returns a promise but
		// i can't seem to understand how to wait for the promise to complete.
		issues.forEach(i => {
		    if (moment(i.created_at).isBetween(rangeStart, rangeEnd)) {
			if ('pull_request' in i)
			    pnew++;
			else
			    inew++;
		    }
		    if (moment(i.closed_at).isBetween(rangeStart, rangeEnd)) {
			if ('pull_request' in i)
			    pclosed++;
			else
			    iclosed++;
		    }
		    if (moment(i.created_at).isBefore(rangeEnd)) {
			if (!i.closed_at) {
			    if ('pull_request' in i)
				pcurrent++;
			    else
				icurrent++;
			}
		    }
		});
		return { 'repo': repo,
			 'issues': [inew, iclosed, icurrent],
			 'prs': [pnew, pclosed, pcurrent] };
	    }).catch(error => {
		console.log(error.message);
	    });
    }    

    // To count the authors we get all the references for master since beginning of the year
    // and accumulate all the authors. Then we check which ones were author in the range
    // Then print all authors in the range and all authors in the range that were not authors between
    // the beginning of the year and the beginning of the range.
    //
    // Returned data will look like:
    // { /authorlogin/: {
    //           'name': /authorname/,
    //           'commits': [
    //                   { 'repo': /reponame/,
    //                     'sha': /commitsha/,
    //                     'date': /commitdate/ } ...manycommits] } ...manyauthorlogin }
    function countAuthorsSince(repo, startOfTime, rangeStart, rangeEnd) {
	const options = octokit.repos.listCommits.endpoint.merge({	
	    owner: 'racket',
	    repo: repo,
	    sha: 'master',
	    since: startOfTime
	});
	return octokit.paginate(options)
	    .then(commits => {
		let data = {};
		commits.forEach(commit => {
		    const commitStr = JSON.stringify(commit);
		    var key;
		    if (commit.author)
			key = commit.author.login;
		    else
			key = commit.commit.author.name;

		    if (!(key in data)) {
			data[key] = {
			    name: commit.commit.author.name,
			    commits: []
			};
		    }
		    data[key].commits.push(
			{
			    repo: repo,
			    sha: commit.sha,
			    date: moment(commit.commit.committer.date, 'YYYY-MM-DDTHH:mm:ssZ', true)
			});
		});
		return data;
	    });
    }

    function countCommitsMaster(repo, from, to) {
	const options = octokit.repos.listCommits.endpoint.merge({	
	    owner: 'racket',
	    repo: repo,
	    sha: 'master',
	    since: from,
	    until: to
	});
	return octokit.paginate(options)
	    .then(c => ({repo: repo, ncommits: c.length}))
	    .catch(e => console.log(e.message));
    }
    
    function mergeContributions2(c1, c2) {
	const keys = Object.keys(c1).concat(Object.keys(c2));
	var merged = {};
	
	for (let k of keys) {
	    if (k in c1 && k in c2) {
		merged[k] = {
		    name: c1[k].name,
		    commits: c1[k].commits.concat(c2[k].commits)
			    };
	    }
	    else if(k in c1) {
		merged[k] = c1[k];
	    }
	    else { // k in c2
		merged[k] = c2[k];
	    }
	}
	return merged;
    }
    
    // Receives an array of contributions and merges them together by author
    function mergeContributions(contribArr) {
	if (contribArr.length === 0)
	    return {};
	else if (contribArr.length === 1)
	    return contribArr[0];
	else
	    return mergeContributions(contribArr.slice(2).concat(mergeContributions2(contribArr[0], contribArr[1])));
    }

    function isNewContributor(contributions, startOfTime, rangeStart, rangeEnd) {
	// return a 2-element list [isContributorforRange, isNewContributor]
	var isOldContributor = false;
	var recentContributor = false;
	for(var i = 0; i < contributions.length; i++) {
	    var commit = contributions[i];
	    if (commit.date.isBetween(rangeStart, rangeEnd))
		recentContributor = true;
	    if (commit.date.isBetween(startOfTime, rangeStart))
		isOldContributor = true;
	}
	return [recentContributor, recentContributor && !isOldContributor];
    }
    
    function printAuthorTable(authors, startOfTime, rangeStart, rangeEnd) {
	// Find authors (new contributors) that have a contribution within rangeStart-rangeEnd,
	// but not startOfTime-rangeStart
	var newContributors = [];
	var contributors = [];

	for (const [author, info] of Object.entries(authors)) {
	    var [isRecent, isNew] = isNewContributor(info.commits, startOfTime, rangeStart, rangeEnd);
	    if (isNew) {
		if (info.name) 
		    newContributors.push(info.name);
		else
		    newContributors.push(author);
	    }
	    if (isRecent) {
		if (info.name)
		    contributors.push(info.name);
		else
		    contributors.push(author);
	    }
	}
    
	console.log(`Contributions by (${contributors.length}):`);
	contributors.sort().forEach(name => console.log(`* ${name}`));

	console.log(`Of these, ${newContributors.length} are new contributors for 2020:`);
	newContributors.sort().forEach(name => console.log(`* ${name}`));	    
    }
    
    const yargs = require('yargs');

    const argv = yargs
	  .command('stats', 'Outputs to stdout information for Racket News', {
	      month: {
		  description: 'the month to check',
		  alias: 'm',
		  type: 'number',
	      },
	      year: {
		  description: 'the year to check',
		  alias: 'y',
		  type: 'number',
	      }
	  })
	  .option('authors', {
	      alias: 'a',
	      description: 'output list of authors',
	      type: 'boolean',
	  })
	  .option('issues', {
	      alias: 'i',
	      description: 'output stats on issues/prs',
	      type: 'boolean',
	  })
	  .help()
	  .alias('help', 'h')
	  .argv;

    if (!argv.month || !argv.year) {
	console.log('Missing month and year as arguments');
	process.exit(1);
    }
	
    console.log(`Analyzing repositories for the month of ${argv.month}, ${argv.year}`);

    const monthStr = argv.month < 10 ? `0${argv.month}` : `${argv.month}`;
    const yearStr = argv.year < 100 ? `20${argv.year}` : `${argv.year}`;
    const yearBegin = moment(`${yearStr}-01-01T00:00:00Z`, 'YYYY-MM-DDTHH:mm:ssZ', true);
    const rangeBegin = moment(`${yearStr}-${monthStr}-01T00:00:00Z`, 'YYYY-MM-DDTHH:mm:ssZ', true);
    const rangeEnd = moment(rangeBegin).add(1, 'M'); // add one month to rangeBegin

    console.log(`Year begins: ${yearBegin}`);
    console.log(`Analysis range: ${rangeBegin} - ${rangeEnd}`);
    
    /////////////////////////////////////////////////
    //
    // Issues/PRs Stats
    //
    ////////////////////////////////////////////////
    if(argv.issues) {
	var ipromises = interestingRepos.map(repo => countIssues(repo, rangeBegin, rangeEnd));
	Promise.all(ipromises).then(vs => {
	    vs.forEach(repoInfo => {
		const repo = repoInfo.repo;
		const [inew, iclosed, icurrent] = repoInfo.issues;
		const [pnew, pclosed, pcurrent] = repoInfo.prs;

		countCommitsMaster(repo, rangeBegin, rangeEnd)
		    .then(v => {
			console.log(`Repo ${repo}`);
			console.log(`# Commits: ${v.ncommits}`);
			console.log(`Issues: ${inew}/${iclosed}/${icurrent}`);
			console.log(`PRs: ${pnew}/${pclosed}/${pcurrent}`);
		    })
		    .catch(e => console.log(e.message));
	    });
	}).catch(error => {
	    console.log(error.message);
	});
    }
    
    /////////////////////////////////////////////////
    //
    // Author Contributions
    //
    ////////////////////////////////////////////////
    if (argv.authors) {
	var promises = interestingRepos.map(repo => countAuthorsSince(repo, yearBegin, rangeBegin, rangeEnd));
	var contributionsByAuthor = Promise.all(promises).then(vs => mergeContributions(vs)).catch(error => {
	    console.log(error.message);
	});

	contributionsByAuthor.then(authors => {
	    // Prints authors in date range and new authors since beginning
	    printAuthorTable(authors, yearBegin, rangeBegin, rangeEnd);
	}).catch(error => {
	    console.log(error.message);
	});
    }    
}());
