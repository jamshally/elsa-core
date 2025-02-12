using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AutoMapper;
using Elsa.Models;
using Elsa.Persistence.Specifications;
using Elsa.Providers.Workflows;
using Elsa.Server.Api.Models;
using Elsa.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Swashbuckle.AspNetCore.Annotations;

namespace Elsa.Server.Api.Endpoints.WorkflowRegistry
{
    [ApiController]
    [ApiVersion("1")]
    [Route("v{apiVersion:apiVersion}/workflow-registry/{providerName}")]
    [Produces("application/json")]
    public class List : Controller
    {
        private readonly IEnumerable<IWorkflowProvider> _workflowProviders;
        private readonly ITenantAccessor _tenantAccessor;
        private readonly IMapper _mapper;
        private readonly IServiceProvider _serviceProvider;

        public List(IEnumerable<IWorkflowProvider> workflowProviders, ITenantAccessor tenantAccessor, IMapper mapper, IServiceProvider serviceProvider)
        {
            _workflowProviders = workflowProviders;
            _tenantAccessor = tenantAccessor;
            _mapper = mapper;
            _serviceProvider = serviceProvider;
        }

        [HttpGet]
        [ProducesResponseType(StatusCodes.Status200OK, Type = typeof(PagedList<WorkflowBlueprintSummaryModel>))]
        [SwaggerOperation(
            Summary = "Returns a list of workflow blueprints.",
            Description = "Returns paginated a list of workflow blueprints. When no version options are specified, the latest version is returned.",
            OperationId = "WorkflowBlueprints.List",
            Tags = new[] { "WorkflowBlueprints" })
        ]
        public async Task<ActionResult<PagedList<WorkflowBlueprintSummaryModel>>> Handle(string providerName, int? page = default, int? pageSize = default, VersionOptions? version = default, CancellationToken cancellationToken = default)
        {
            var workflowProvider = _workflowProviders.FirstOrDefault(x => x.GetType().Name == providerName);

            if (workflowProvider == null)
                return BadRequest(new { Error = $"Unknown workflow provider: {providerName}" });

            version ??= VersionOptions.Latest;
            var tenantId = await _tenantAccessor.GetTenantIdAsync(cancellationToken);
            var skip = page * pageSize;
            var workflowBlueprints = await workflowProvider.ListAsync(version.Value, skip, pageSize, tenantId, cancellationToken).ToListAsync(cancellationToken);
            var totalCount = await workflowProvider.CountAsync(version.Value, tenantId, cancellationToken);
            var mappedItems = _mapper.Map<IEnumerable<WorkflowBlueprintSummaryModel>>(workflowBlueprints).ToList();

            return new PagedList<WorkflowBlueprintSummaryModel>(mappedItems, page, pageSize, totalCount);
        }
    }
}