#!/bin/bash
set -e # Exit with nonzero exit code if anything fails

# Pull requests and non-master commits shouldn't try to deploy, just build to verify
if [ "$TRAVIS_PULL_REQUEST" != "false" -o "$TRAVIS_BRANCH" != "master" ]; then
    echo "Skipping deploy for a pull request; just doing a build"
    npm run spec
    exit 0
fi

# Save the current commit's hash
SHA=`git rev-parse --verify HEAD`

# Clone the existing gh-pages for this repo into out/
git clone -b gh-pages "https://${GH_REF}" out

# Clean out existing contents
rm -rf out/**/* || exit 0

# Run our compile script
npm run spec

# Now let's go have some fun with the cloned repo
cd out
git config user.name "Travis CI"
git config user.email "d@domenic.me"

# Commit and push the "changes", i.e. the new version.
# The delta will show diffs between new and old versions.
git add .
git commit -m "Deploy to GitHub Pages: ${SHA}"
git push "https://${GH_TOKEN}@${GH_REF}" gh-pages
